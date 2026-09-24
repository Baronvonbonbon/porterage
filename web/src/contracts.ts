// The deployed contracts, for reads (over the Ethereum RPC) and for encoding
// the calls that hostchain.ts and the session key send.

import {
  Contract,
  Interface,
  JsonRpcProvider,
  ZeroAddress,
  encodeBytes32String,
  type Wallet,
} from "ethers";
import { CHAIN, DEPLOYED } from "./config";
import Drivers from "./abi/PorterDrivers.json";
import Venues from "./abi/PorterVenues.json";
import Orders from "./abi/PorterOrders.json";
import Settlement from "./abi/PorterSettlement.json";
import Vault from "./abi/PorterVault.json";
import Disputes from "./abi/PorterDisputes.json";
import Ratings from "./abi/PorterRatings.json";
import PauseRegistry from "./abi/PorterPauseRegistry.json";

export const ABI = {
  drivers: new Interface(Drivers),
  venues: new Interface(Venues),
  orders: new Interface(Orders),
  settlement: new Interface(Settlement),
  vault: new Interface(Vault),
  disputes: new Interface(Disputes),
  ratings: new Interface(Ratings),
  pauseRegistry: new Interface(PauseRegistry),
};
export type ContractName = keyof typeof ABI;

// A copy, not the import: `resolveFromRouter` writes into this, and mutating
// the module's own JSON object would quietly change what every other importer
// of `deployed.json` sees.
const addresses = { ...DEPLOYED } as Partial<Record<ContractName, string>>;

/** True once the deploy script has written every address the app needs. */
export function deployed(): boolean {
  return (Object.keys(ABI) as ContractName[]).every((k) => !!addresses[k]);
}

export function addressOf(name: ContractName): string {
  const a = addresses[name];
  if (!a) throw new Error(`${name} is not deployed yet`);
  return a;
}

let provider: JsonRpcProvider | null = null;
export function ethProvider(): JsonRpcProvider {
  provider ??= new JsonRpcProvider(CHAIN.ethRpc, Number(CHAIN.chainId), {
    staticNetwork: true,
  });
  return provider;
}

/** A read-only handle on a deployed contract. */
export function read(name: ContractName): Contract {
  return new Contract(addressOf(name), ABI[name], ethProvider());
}

/**
 * A read-only handle on a *particular* deployment, rather than the current one.
 *
 * Order ids are per-contract and sequential, and under the freeze-and-drain
 * upgrade model two deployments are live at once while the old one drains. So
 * order #7 exists on both, as two different orders. Anything that holds a
 * stored order must read it from the contract it was created on — see
 * `OrderRecord.at` — or a customer opens their order and is shown somebody
 * else's.
 *
 * `at` being undefined means "before this was recorded", which can only be an
 * order from the current deployment, so it falls back to that.
 */
export function readAt(name: ContractName, at?: string): Contract {
  return new Contract(at || addressOf(name), ABI[name], ethProvider());
}

/** As `readAt`, for a handle that can send. */
export function writeAt(
  name: ContractName,
  signer: Wallet,
  at?: string
): Contract {
  return new Contract(at || addressOf(name), ABI[name], writable(signer));
}

/**
 * A signer that can actually send a transaction.
 *
 * `keys.ts` derives wallets from entropy with `new Wallet(hex)`, which has no
 * provider — it can sign, and it cannot send. Most of this app never notices,
 * because the host signs its transactions and the burner paths call `.connect`
 * on the way out. The driver's session key is the exception: it is derived
 * once in `Driver.tsx`, held in state, and passed down through several screens
 * to helpers that send with it. One missing `.connect` up there turned every
 * driver write into
 *
 *   missing provider (operation="sendTransaction", code=UNSUPPORTED_OPERATION)
 *
 * and it surfaced on a phone at the one moment a driver cares about, tapping
 * Bid. Connecting at each call site is the fix that works until somebody adds
 * a seventh call site, so instead every signer-bound contract in this app is
 * built through here and the question cannot be got wrong again.
 */
export function writable(signer: Wallet): Wallet {
  return signer.provider ? signer : signer.connect(ethProvider());
}

/** A writable handle on a deployed contract, with the provider guaranteed. */
export function write(name: ContractName, signer: Wallet): Contract {
  return new Contract(addressOf(name), ABI[name], writable(signer));
}

/** Calldata for `fn(args)` on `name`. */
export function encode(
  name: ContractName,
  fn: string,
  args: unknown[] = []
): string {
  return ABI[name].encodeFunctionData(fn, args);
}

/**
 * Ask the governance router where each contract currently lives.
 *
 * Until this existed the registry was decorative: every address came from
 * `deployed.json`, baked in at build time, so an on-chain upgrade reached
 * nobody until the app was rebuilt and republished. On a phone that can mean
 * days, and in the meantime the app is talking to a contract that has been
 * frozen against exactly the calls it is about to make.
 *
 * This does not widen who is trusted. The router's owner is already the
 * upgrade authority — it can freeze these contracts and re-point every other
 * client at will — so reading its answer grants it nothing it did not have.
 * What it does change is the failure mode: an address that moves is now
 * followed rather than missed.
 *
 * Deliberately best-effort. A zero address, an unreachable RPC or a slow one
 * all leave the baked addresses in place, because a stale address the app can
 * still read beats no address at all.
 */
export async function resolveFromRouter(
  timeoutMs = 4000
): Promise<Partial<Record<ContractName, string>>> {
  const routerAt = (DEPLOYED as { router?: string }).router;
  if (!routerAt) return {};

  const router = new Contract(
    routerAt,
    ["function currentAddrOf(bytes32) view returns (address)"],
    ethProvider()
  );

  const names = Object.keys(ABI) as ContractName[];
  const moved: Partial<Record<ContractName, string>> = {};

  const lookups = Promise.all(
    names.map(async (n) => {
      const found = (await router.currentAddrOf(
        encodeBytes32String(n)
      )) as string;
      if (!found || found === ZeroAddress) return;
      if (found.toLowerCase() === addresses[n]?.toLowerCase()) return;
      moved[n] = found;
    })
  );

  // One slow name must not hold up the whole app, and a half-applied map is
  // worse than none: nothing is written until every lookup is back.
  const timedOut = Symbol("timeout");
  const raced = await Promise.race([
    lookups.then(() => "ok" as const).catch(() => "failed" as const),
    new Promise<typeof timedOut>((r) => setTimeout(() => r(timedOut), timeoutMs)),
  ]);
  if (raced !== "ok") return {};

  Object.assign(addresses, moved);
  return moved;
}
