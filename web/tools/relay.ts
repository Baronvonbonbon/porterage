// The optional relay (docs/PLAN.md §8): a funding-market submitter that runs on
// a computer instead of a phone. It listens for funding requests on the People
// chains' Statement Store and submits each valid one, tipped by the burner.
//
// It is a convenience, not a dependency: any driver with "Help fund private
// orders" on does the same job. It holds no one's money; the proof fixes where
// each withdrawal goes, and the gas estimate rejects a bad one for free.
//
// Usage, from the repo root:  npm run relay
// RELAY_KEY_FILE: Ethereum key that pays gas (default ~/.config/porterage/deploy-key)

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { JsonRpcProvider, Wallet, formatEther, getBytes } from "ethers";
import { CHAIN, SHIELD_POOL } from "../src/config";
import DEPLOYED from "../src/deployed.json";
import { decodeStatement } from "../src/market/scale";
import {
  FUND_TOPIC,
  PAYOUT_BYTES,
  PAYOUT_TOPIC,
  REQUEST_BYTES,
  decodePayout,
  decodeRequest,
} from "../src/market/request";
import { submitPayout, submitRequest } from "../src/market/submit";

// The devnet Polkadot app keeps statements on People Next; the public Paseo
// People chain is watched too, in case a host uses it.
const STORES = [
  "wss://paseo-people-next-system-rpc.polkadot.io",
  "wss://people-paseo.rotko.net",
];

const eth = new JsonRpcProvider(CHAIN.ethRpc, Number(CHAIN.chainId), {
  staticNetwork: true,
});
const key = readFileSync(
  process.env.RELAY_KEY_FILE ??
    join(homedir(), ".config", "porterage", "deploy-key"),
  "utf8"
).trim();
const signer = new Wallet(key, eth);
const log = (...a: unknown[]) =>
  console.log(new Date().toISOString().slice(11, 19), ...a);

let queue = Promise.resolve();
function handle(hex: string, from: string) {
  let bytes: Uint8Array | undefined;
  try {
    bytes = decodeStatement(getBytes(hex)).data;
  } catch {
    return;
  }
  if (
    !bytes ||
    (bytes.length !== REQUEST_BYTES && bytes.length !== PAYOUT_BYTES)
  )
    return;
  queue = queue.then(async () => {
    try {
      if (bytes!.length === REQUEST_BYTES) {
        const req = decodeRequest(bytes!);
        const r = await submitRequest(req, SHIELD_POOL, signer);
        if (r.status === "sent")
          log(
            `funded ${req.proof.recipient} with ${formatEther(
              req.withdrawn
            )} PAS, tx ${r.hash} (via ${from})`
          );
        else if (r.reason !== "already handled")
          log(`skipped ${req.proof.recipient}: ${r.reason}`);
      } else {
        const req = decodePayout(bytes!);
        const r = await submitPayout(
          req,
          (DEPLOYED as { vault: string }).vault,
          signer
        );
        if (r.status === "sent")
          log(
            `released a payout of ${formatEther(req.bucket)} PAS, tx ${
              r.hash
            } (via ${from})`
          );
        else if (r.reason !== "already handled")
          log(`skipped a payout: ${r.reason}`);
      }
    } catch (e) {
      log("failed:", (e as Error).message);
    }
  });
}

function watch(url: string, backoffMs = 10_000) {
  const ws = new WebSocket(url);
  const name = new URL(url).host;
  // One reconnect per socket: an error also fires a close, and calling close()
  // from onerror re-enters the handler until the stack runs out (seen 2026-09-20).
  let done = false;
  const again = (why: string) => {
    if (done) return;
    done = true;
    log(`${name} ${why}; reconnecting in ${Math.round(backoffMs / 1000)} s`);
    setTimeout(() => watch(url, Math.min(backoffMs * 2, 300_000)), backoffMs);
  };
  ws.onopen = () => {
    backoffMs = 10_000;
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "statement_subscribeStatement",
        params: [{ matchAny: [FUND_TOPIC, PAYOUT_TOPIC] }],
      })
    );
    log(`listening on ${name}`);
  };
  ws.onmessage = (m) => {
    const r = JSON.parse(String(m.data));
    for (const s of r.params?.result?.data?.statements ?? []) handle(s, name);
  };
  ws.onclose = () => again("closed");
  ws.onerror = () => again("errored");
}

log(
  `relay ${signer.address}, ${formatEther(
    await eth.getBalance(signer.address)
  )} PAS for gas`
);
STORES.forEach(watch);
