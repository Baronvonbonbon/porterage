// Top the contract deployer up from the name key (the account that pays for
// porterage.dot), both of which are this computer's own keys.
//
// They hold PAS on opposite sides of the same chain: the name key is an sr25519
// account, and the deployer is an Ethereum key whose Substrate account is its
// H160 padded with 0xEE — pallet-revive's mapping. So a plain balance transfer
// to that padded account shows up as the deployer's EVM balance.
//
// Usage, from the repo root:
//   node tools/fund-deployer.mjs [amount in PAS, default 60]
//
// It never prints either key: only addresses and balances.

import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";
import { AccountId, createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountOf, KEY_FILE } from "./name-key.mjs";
import { KEY_FILE as DEPLOY_KEY_FILE } from "./deploy-key.mjs";

const WSS = "wss://asset-hub-paseo-rpc.n.dwellir.com";
const PLANCK = 10n ** 10n; // PAS has 10 decimals on the Substrate side
/** The Paseo hubs' transaction extensions, all None. */
const EXTENSIONS = Object.fromEntries(
  ["AsPgas", "AsScarcity", "AsRingAlias", "AsDotnsGateway", "RestrictOrigins"].map((e) => [
    e,
    { value: new Uint8Array([0]) },
  ]),
);

const pas = (planck) => (Number(planck) / Number(PLANCK)).toFixed(4);

const amount = BigInt(Math.round(Number(process.argv[2] ?? 60) * 1e4)) * (PLANCK / 10000n);
if (!(amount > 0n)) throw new Error("ask for a positive amount");

const mnemonic = existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : null;
if (!mnemonic) throw new Error(`no name key at ${KEY_FILE}: run npm run name-key first`);
const from = accountOf(mnemonic);

// The deployer's address only — the private key stays in its file.
const deployKey = readFileSync(DEPLOY_KEY_FILE, "utf8").trim();
const { computeAddress } = await import("ethers");
const deployer = computeAddress(deployKey.startsWith("0x") ? deployKey : `0x${deployKey}`);
// As SS58, because that is how the runtime's codec wants an account.
const destination = AccountId(0).dec(
  Uint8Array.from(Buffer.from(deployer.slice(2).toLowerCase() + "ee".repeat(12), "hex")),
);

const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(mnemonic)));
const pair = derive("");
const signer = getPolkadotSigner(pair.publicKey, "Sr25519", pair.sign);

const client = createClient(getWsProvider(WSS));
const api = client.getUnsafeApi();

const balanceOf = async (who) => (await api.query.System.Account.getValue(who)).data.free;
console.log(`from  ${from.ss58}  ${pas(await balanceOf(from.ss58))} PAS`);
console.log(`to    ${deployer}  ${pas(await balanceOf(destination))} PAS  (as ${destination})`);
console.log(`\nsending ${pas(amount)} PAS…`);

const result = await api.tx.Balances.transfer_keep_alive({ dest: { type: "Id", value: destination }, value: amount }).signAndSubmit(signer, {
  customSignedExtensions: EXTENSIONS,
});
if (!result.ok) throw new Error(`the transfer failed: ${JSON.stringify(result.dispatchError, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
console.log(`included in block ${result.block.number}`);
console.log(`\nfrom  ${pas(await balanceOf(from.ss58))} PAS\nto    ${pas(await balanceOf(destination))} PAS`);
client.destroy();
