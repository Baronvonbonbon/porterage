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

import { existsSync, readFileSync } from "node:fs";
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
import {
  CLAIM_BYTES,
  CLAIM_TOPIC,
  Claims,
  decodeClaim,
} from "../src/market/auction";

// The devnet Polkadot app keeps statements on People Next; the public Paseo
// People chain is watched too, in case a host uses it.
const STORES = [
  "wss://paseo-people-next-system-rpc.polkadot.io",
  "wss://people-paseo.rotko.net",
];

const eth = new JsonRpcProvider(CHAIN.ethRpc, Number(CHAIN.chainId), {
  staticNetwork: true,
});
// The relay's OWN key, not the deploy key.
//
// It used to default to `deploy-key`, which on this testnet is also the
// treasury, the arbiter and the upgrade authority. The relay is the only one of
// those that runs unattended on a networked machine with its key loaded, so
// that default made the most exposed key the most privileged one. A relay needs
// gas and nothing else: the proofs it submits fix where every withdrawal goes,
// so a stolen relay key costs the gas left in it.
//
// The deploy key still works, to avoid breaking a running relay, but it says so
// every time. `npm run relay-key -- --fund 20` makes the warning go away.
const CONFIG = join(homedir(), ".config", "porterage");
const relayKeyFile = process.env.RELAY_KEY_FILE ?? join(CONFIG, "relay-key");
const usingDeployKey = !existsSync(relayKeyFile);
const key = readFileSync(
  usingDeployKey ? join(CONFIG, "deploy-key") : relayKeyFile,
  "utf8"
).trim();
const signer = new Wallet(key, eth);
const log = (...a: unknown[]) =>
  console.log(new Date().toISOString().slice(11, 19), ...a);

/**
 * Requests seen but not yet taken, because the price had not climbed to this
 * operator's cost. THIS IS NOT AN OPTIMISATION — it is what makes a rising
 * price a market at all. A relay that judges each request once, on arrival,
 * sees every one of them at its floor, finds it too cheap, and never looks
 * again; the auction then has exactly one price, the opening one, and nobody
 * ever bids. So a "waiting" verdict is kept and re-asked.
 */
const pending = new Map<
  string,
  { at: number; run: () => Promise<Outcome>; describe: string }
>();

type Outcome = Awaited<ReturnType<typeof submitRequest>>;

/** Long enough that a request cannot outlive its statement (an hour). */
const PENDING_MS = 60 * 60_000;
const RETRY_MS = 3_000;

const claims = new Claims();

let queue = Promise.resolve();

function attempt(key: string, describe: string, run: () => Promise<Outcome>) {
  pending.set(key, { at: Date.now(), run, describe });
  queue = queue.then(async () => {
    const held = pending.get(key);
    if (!held) return;
    try {
      const r = await run();
      if (r.status === "sent") {
        pending.delete(key);
        claims.forget(key);
        log(`${describe}, tx ${r.hash}, fee ${formatEther(r.fee)} PAS`);
      } else if (r.status === "skipped") {
        pending.delete(key);
        if (r.reason !== "already handled") log(`skipped ${describe}: ${r.reason}`);
      }
      // "waiting" stays in `pending` for the ticker to ask again.
    } catch (e) {
      pending.delete(key);
      log("failed:", (e as Error).message);
    }
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [key, held] of [...pending]) {
    if (now - held.at > PENDING_MS) {
      pending.delete(key);
      log(`gave up on ${held.describe}: nobody's price ever cleared`);
      continue;
    }
    attempt(key, held.describe, held.run);
  }
}, RETRY_MS);

function handle(hex: string, from: string) {
  let bytes: Uint8Array | undefined;
  try {
    bytes = decodeStatement(getBytes(hex)).data;
  } catch {
    return;
  }
  if (!bytes) return;

  if (bytes.length === CLAIM_BYTES) {
    const c = decodeClaim(bytes);
    if (c) claims.heard(c);
    return;
  }
  if (bytes.length !== REQUEST_BYTES && bytes.length !== PAYOUT_BYTES) return;

  try {
    if (bytes.length === REQUEST_BYTES) {
      const req = decodeRequest(bytes);
      const key = req.proof.pubSignals[1];
      if (pending.has(key)) return; // already being worked
      attempt(
        key,
        `funded ${req.proof.recipient} with ${formatEther(
          req.withdrawn
        )} PAS (via ${from})`,
        // No `announce`: publishing a claim needs a Statement Store account,
        // and this process has an Ethereum key and nothing else. So the relay
        // yields to anyone who claims and never claims itself — which is the
        // right way round. A phone running "Help fund private orders" should
        // win the job and the fee ahead of the operator's own machine.
        () => submitRequest(req, SHIELD_POOL, signer, { claims })
      );
    } else {
      const req = decodePayout(bytes);
      if (pending.has(req.nullifierHash)) return;
      attempt(
        req.nullifierHash,
        `released a payout of ${formatEther(req.bucket)} PAS (via ${from})`,
        () =>
          submitPayout(req, (DEPLOYED as { vault: string }).vault, signer, {
            claims,
          })
      );
    }
  } catch {
    /* not ours, or malformed */
  }
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
        params: [{ matchAny: [FUND_TOPIC, PAYOUT_TOPIC, CLAIM_TOPIC] }],
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
if (usingDeployKey) {
  log(
    "WARNING: running on the DEPLOY key. That key is also the treasury, the " +
      "arbiter and the upgrade authority, and it is now sitting on a networked " +
      "machine. Run `npm run relay-key -- --fund 20` and restart."
  );
}
STORES.forEach(watch);
