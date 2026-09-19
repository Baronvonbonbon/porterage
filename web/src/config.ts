// Where Porterage runs and what it talks to.

/** The .dot label the app is published under. Every product-scoped key and account derives from it. */
export const PRODUCT_ID = "porterage";

/** Paseo Asset Hub, where the contracts live (docs/PLAN.md §1). */
export const CHAIN = {
  name: "Paseo Asset Hub",
  genesis: "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2",
  /** Substrate RPC: host-account transactions (Revive.call) and runtime reads. */
  wss: "wss://asset-hub-paseo-rpc.n.dwellir.com",
  /** Ethereum RPC: session keys and burners send ordinary EVM transactions here. */
  ethRpc: "https://eth-rpc-testnet.polkadot.io/",
  chainId: 420420417n,
  /** PAS has 10 decimals on the Substrate side, 18 on the EVM side. */
  nativeDecimals: 10,
  ss58Prefix: 0,
} as const;

/** Contract addresses, written by the deploy script. Empty until the contracts are deployed. */
export { default as DEPLOYED } from "./deployed.json";
