// Contract calls from the user's Polkadot app account (docs/PLAN.md §3).
//
// A host account signs sr25519, so it can't send an Ethereum transaction. It
// calls a contract with a Substrate `Revive.call` instead, signed through the
// host (one tap per call: AutoSigning is NotAvailable on mobile). The contract
// sees the account as the H160 that `ReviveApi.address` derives from it, and
// this runtime maps accounts automatically, so there is no separate
// map_account step.
//
// Every call is dry-run first through `ReviveApi.call`. That gives the weight
// and storage deposit to allow, and turns a revert into an error before the
// user is asked to tap.

import { getAccountsProvider } from "@parity/product-sdk-host";
import { AccountId, createClient, type PolkadotClient, type PolkadotSigner } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { getBytes, hexlify } from "ethers";
import { CHAIN, PRODUCT_ID } from "./config";
import { inHost, withTimeout } from "./host";

/** The Paseo hubs' own transaction extensions, all None (sonde, 2026-09-19). */
const HUB_EXTENSIONS = Object.fromEntries(
  ["AsPgas", "AsScarcity", "AsRingAlias", "AsDotnsGateway", "RestrictOrigins"].map((e) => [
    e,
    { value: new Uint8Array([0]) },
  ]),
);

/** Headroom on the dry-run's weight and deposit, for state that moves before inclusion. */
const MARGIN = 5n; // +20%
const TX_MS = 180_000;

/** ReviveApi.call's result on Paseo Asset Hub (descriptors, 2026-09-19). */
interface Weight {
  ref_time: bigint;
  proof_size: bigint;
}
interface DryRunResult {
  weight_required: Weight;
  storage_deposit: { type: "Charge" | "Refund"; value: bigint };
  result: { success: true; value: { flags: number; data: Uint8Array } } | { success: false; value: unknown };
}

export interface HostAccount {
  publicKey: Uint8Array;
  /** SS58 address, prefix 0. */
  address: string;
  /** The H160 contracts see as msg.sender. */
  evm: string;
  signer: PolkadotSigner;
}

let client: PolkadotClient | null = null;
function chain() {
  client ??= createClient(getWsProvider(CHAIN.wss));
  return client.getUnsafeApi();
}

let account: Promise<HostAccount> | null = null;

/** Product account #0 for this .dot label: the user's identity as a driver or venue. */
export function hostAccount(): Promise<HostAccount> {
  return (account ??= (async () => {
    if (!(await inHost())) throw new Error("open Porterage in the Polkadot app to use your account");
    const provider = await getAccountsProvider();
    if (!provider) throw new Error("the Polkadot app offers no accounts");
    const r = await provider.getProductAccount(PRODUCT_ID, 0).match(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e }),
    );
    if (!r.ok) throw new Error(`could not get your account: ${JSON.stringify(r.e)}`);
    const acct = r.v as unknown as { publicKey: Uint8Array };
    const address = AccountId(CHAIN.ss58Prefix).dec(acct.publicKey);
    const evm = (await chain().apis.ReviveApi.address(address)) as string;
    return { publicKey: acct.publicKey, address, evm, signer: provider.getProductAccountSigner(r.v) };
  })()).catch((e) => {
    account = null;
    throw e;
  });
}

/** Free PAS on the Substrate side, in planck (10 decimals). */
export async function freeBalance(address: string): Promise<bigint> {
  const info = (await chain().query.System.Account.getValue(address)) as { data: { free: bigint } };
  return info.data.free;
}

/** The Substrate account behind an Ethereum-style key: its H160 padded with 0xEE. */
export function ethDerivedAccount(evm: string): string {
  return evm.toLowerCase() + "ee".repeat(12);
}

const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export class ContractRevert extends Error {
  constructor(public data: string) {
    super(`the contract refused the call (${data.slice(0, 74)})`);
  }
}

/** Dry-run a call as `origin`. Returns what the runtime needs to include it. */
export async function dryRun(origin: string, dest: string, data: string, value = 0n) {
  const r = (await chain().apis.ReviveApi.call(
    origin, dest, value, undefined, undefined, getBytes(data),
  )) as DryRunResult;
  if (!r.result.success) throw new Error(`dry run failed: ${JSON.stringify(r.result.value, big)}`);
  const out = hexlify(r.result.value.data);
  if (r.result.value.flags & 1) throw new ContractRevert(out);
  const deposit = r.storage_deposit.type === "Charge" ? r.storage_deposit.value : 0n;
  return {
    returnData: out,
    weight: {
      ref_time: r.weight_required.ref_time + r.weight_required.ref_time / MARGIN,
      proof_size: r.weight_required.proof_size + r.weight_required.proof_size / MARGIN,
    },
    depositLimit: deposit + deposit / MARGIN,
  };
}

/** Call a contract as the user's host account. One tap. Resolves when included in a block. */
export async function hostCall(dest: string, data: string, value = 0n): Promise<{ block: number }> {
  const me = await hostAccount();
  const plan = await dryRun(me.address, dest, data, value);
  const tx = chain().tx.Revive.call({
    dest,
    value,
    weight_limit: plan.weight,
    storage_deposit_limit: plan.depositLimit,
    data: getBytes(data),
  });
  const r = await withTimeout(
    tx.signAndSubmit(me.signer, { customSignedExtensions: HUB_EXTENSIONS }),
    TX_MS,
    "transaction",
  );
  if (!r.ok) throw new Error(`the transaction failed: ${JSON.stringify(r.dispatchError, big)}`);
  return { block: r.block.number };
}

/** Send PAS from the host account to an Ethereum-style key (a session key's gas). One tap. */
export async function hostFund(evm: string, planck: bigint): Promise<{ block: number }> {
  const me = await hostAccount();
  const tx = chain().tx.Balances.transfer_keep_alive({
    dest: { type: "Id", value: AccountId(CHAIN.ss58Prefix).dec(getBytes(ethDerivedAccount(evm))) },
    value: planck,
  });
  const r = await withTimeout(
    tx.signAndSubmit(me.signer, { customSignedExtensions: HUB_EXTENSIONS }),
    TX_MS,
    "transfer",
  );
  if (!r.ok) throw new Error(`the transfer failed: ${JSON.stringify(r.dispatchError, big)}`);
  return { block: r.block.number };
}
