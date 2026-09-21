// The relay's own key, which is not the deploy key.
//
// WHY THIS FILE EXISTS. The relay defaulted to `~/.config/porterage/deploy-key`,
// and on this testnet that one key is also the TREASURY (every protocol fee),
// the ARBITER (can rule on any dispute) and the DEPLOYER (upgrade authority
// through PorterGovernanceRouter). The relay is the only one of those four that
// runs unattended on a networked machine with the key loaded — so the most
// exposed key in the system was also the most privileged. Anyone who got the
// relay box got the money, the disputes and the upgrade path.
//
// A relay needs exactly one capability: enough PAS to pay gas. It holds no
// one's funds, and the proofs it submits fix where every withdrawal goes, so a
// stolen relay key costs whatever gas is left in it and nothing else.
//
// Usage, from the repo root:
//   npm run relay-key            create the key if there is none; print it and its balance
//   npm run relay-key -- --fund 20   also send it 20 PAS from the deploy key

import { Wallet, JsonRpcProvider, formatEther, parseEther } from "ethers";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readKey as readDeployKey, PASEO_ETH_RPC } from "./deploy-key.mjs";

export const RELAY_KEY_FILE =
  process.env.RELAY_KEY_FILE ??
  join(homedir(), ".config", "porterage", "relay-key");

export function readRelayKey() {
  return existsSync(RELAY_KEY_FILE)
    ? readFileSync(RELAY_KEY_FILE, "utf8").trim()
    : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let key = readRelayKey();
  if (key) {
    console.log(`Using the relay key in ${RELAY_KEY_FILE}.`);
  } else {
    key = Wallet.createRandom().privateKey;
    mkdirSync(dirname(RELAY_KEY_FILE), { recursive: true, mode: 0o700 });
    writeFileSync(RELAY_KEY_FILE, key + "\n", { mode: 0o600 });
    console.log(`Created a relay key in ${RELAY_KEY_FILE}.`);
    console.log(
      "It only ever pays gas. Losing it costs the gas left in it and nothing else."
    );
  }

  const provider = new JsonRpcProvider(PASEO_ETH_RPC);
  const relay = new Wallet(key, provider);
  console.log(`Relay ${relay.address}`);

  const at = process.argv.indexOf("--fund");
  if (at !== -1) {
    const amount = parseEther(process.argv[at + 1] ?? "20");
    const deployKey = readDeployKey();
    if (!deployKey) {
      console.log("No deploy key to fund from; run `npm run deploy-key` first.");
    } else {
      const from = new Wallet(deployKey, provider);
      console.log(`Sending ${formatEther(amount)} PAS from ${from.address}…`);
      const tx = await from.sendTransaction({ to: relay.address, value: amount });
      await tx.wait();
      console.log(`  ${tx.hash}`);
    }
  }

  const balance = await provider.getBalance(relay.address).catch(() => null);
  console.log(
    balance === null
      ? "Balance: Paseo did not answer"
      : `Balance ${formatEther(balance)} PAS`
  );
  if (balance !== null && balance < parseEther("5")) {
    console.log(
      "Low. Top it up with `npm run relay-key -- --fund 20` before running the relay."
    );
  }
}
