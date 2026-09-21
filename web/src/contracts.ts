// The deployed contracts, for reads (over the Ethereum RPC) and for encoding
// the calls that hostchain.ts and the session key send.

import { Contract, Interface, JsonRpcProvider, type Wallet } from "ethers";
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

const addresses = DEPLOYED as Partial<Record<ContractName, string>>;

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
