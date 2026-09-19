// The contract deployer key, kept on this computer (the almanac pattern).
//
// The key is written once to KEY_FILE (mode 600, outside the repo) and never
// printed. This shows the address to fund and what it holds.
//
// Usage, from the repo root:
//   npm run deploy-key          create the key if there is none; print its address and balance

import { Wallet, JsonRpcProvider, formatEther } from "ethers";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const KEY_FILE = process.env.PORTERAGE_DEPLOY_KEY ?? join(homedir(), ".config", "porterage", "deploy-key");
export const PASEO_ETH_RPC = process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";

/** The deployer's private key, or null when there is none yet. */
export function readKey() {
  return existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let key = readKey();
  if (key) {
    console.log(`Using the deploy key in ${KEY_FILE}.`);
  } else {
    key = Wallet.createRandom().privateKey;
    mkdirSync(dirname(KEY_FILE), { recursive: true, mode: 0o700 });
    writeFileSync(KEY_FILE, key + "\n", { mode: 0o600 });
    console.log(`Created a deploy key in ${KEY_FILE}. Back that file up; it is never printed.`);
  }
  const address = new Wallet(key).address;
  const balance = await new JsonRpcProvider(PASEO_ETH_RPC).getBalance(address).catch(() => null);
  console.log(`Deployer ${address}`);
  console.log(balance === null ? "Balance: Paseo did not answer" : `Balance  ${formatEther(balance)} PAS on Paseo Asset Hub`);
  if (balance !== null && balance < 50n * 10n ** 18n) console.log("Fund it with at least 50 PAS before `npm run deploy`.");
}
