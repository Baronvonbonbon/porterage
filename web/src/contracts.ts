// The deployed contracts, for reads (over the Ethereum RPC) and for encoding
// the calls that hostchain.ts and the session key send.

import { Contract, Interface, JsonRpcProvider } from "ethers";
import { CHAIN, DEPLOYED } from "./config";
import Drivers from "./abi/PorterDrivers.json";
import Venues from "./abi/PorterVenues.json";
import Orders from "./abi/PorterOrders.json";
import Settlement from "./abi/PorterSettlement.json";
import Vault from "./abi/PorterVault.json";
import Disputes from "./abi/PorterDisputes.json";
import Ratings from "./abi/PorterRatings.json";

export const ABI = {
  drivers: new Interface(Drivers),
  venues: new Interface(Venues),
  orders: new Interface(Orders),
  settlement: new Interface(Settlement),
  vault: new Interface(Vault),
  disputes: new Interface(Disputes),
  ratings: new Interface(Ratings),
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
  provider ??= new JsonRpcProvider(CHAIN.ethRpc, Number(CHAIN.chainId), { staticNetwork: true });
  return provider;
}

/** A read-only handle on a deployed contract. */
export function read(name: ContractName): Contract {
  return new Contract(addressOf(name), ABI[name], ethProvider());
}

/** Calldata for `fn(args)` on `name`. */
export function encode(name: ContractName, fn: string, args: unknown[] = []): string {
  return ABI[name].encodeFunctionData(fn, args);
}
