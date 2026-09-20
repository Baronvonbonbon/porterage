// Live check of a private payout (npx vite-node tools/live-payout.ts).
//
// 1. credits the vault with 1 PAS, as settlement would pay a driver
// 2. inserts a 1 PAS payout note, as the payee's one tap does
// 3. proves ownership and binds a fresh pool commitment, as the payee's phone does
// 4. submits the spend from a DIFFERENT key, as a stranger on the market does
// 5. checks the pool note landed and its path reaches the live root
//
// Both keys here are Ethereum keys, so the whole run is visible to the Ethereum
// RPC; on a phone step 2 is a Substrate call, which the leaf reader handles.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  formatEther,
  toBigInt,
} from "ethers";
import { CHAIN, SHIELD_POOL } from "../src/config";
import DEPLOYED from "../src/deployed.json";
import {
  BN254_R,
  commitmentOf,
  findLeafBlock,
  notePathsAt,
  reconstructPath,
  type Note,
} from "../src/shield/pool";
import { contractEvents, poolInserts } from "../src/shield/events";
import {
  INSERTED_TOPIC,
  noteLeaves,
  payoutCommitment,
  proveSpend,
} from "../src/shield/payout";
import { submitPayout } from "../src/market/submit";
import { encodePayout, decodePayout } from "../src/market/request";

const PAS = 10n ** 18n;
const vaultAddr = (DEPLOYED as { vault: string }).vault;
const eth = new JsonRpcProvider(CHAIN.ethRpc, Number(CHAIN.chainId), {
  staticNetwork: true,
});
const payee = new Wallet(
  readFileSync(
    join(homedir(), ".config", "porterage", "deploy-key"),
    "utf8"
  ).trim(),
  eth
);
// A second key stands in for the stranger who submits; funded from the payee.
const stranger = new Wallet(Wallet.createRandom().privateKey, eth);
const client = createClient(getWsProvider(CHAIN.wss));

const VAULT_ABI = [
  "function credit(address to) payable",
  "function setAuthorized(address account, bool enabled)",
  "function authorized(address) view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function insertShieldNote(uint96 bucket, uint256 commitment)",
  "function nextNoteIndex() view returns (uint32)",
];
const vault = new Contract(vaultAddr, VAULT_ABI, payee);
const send = async (
  label: string,
  p: Promise<{ hash: string; wait: () => Promise<unknown> }>
) => {
  const tx = await p;
  const before = await eth.getTransactionCount(payee.address);
  for (let i = 0; i < 60; i++) {
    if ((await eth.getTransactionCount(payee.address)) >= before) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`   ${label} ${tx.hash.slice(0, 14)}…`);
};

// 1 + 2
console.log(`payee ${payee.address}`);
// Only authorized contracts may credit, so the owner authorizes this key for
// the length of the test and revokes it below.
await send("authorized the test key", vault.setAuthorized(payee.address, true));
await new Promise((r) => setTimeout(r, 8000));
await send("credited the vault", vault.credit(payee.address, { value: PAS }));
await new Promise((r) => setTimeout(r, 8000));
console.log(
  `1. vault balance ${formatEther(await vault.balanceOf(payee.address))} PAS`
);

const field = (s: string) => (toBigInt(s) % BN254_R).toString();
const note = {
  n: 0,
  bucket: PAS.toString(),
  nullifier: field(Wallet.createRandom().privateKey),
  secret: field(Wallet.createRandom().privateKey),
};
await send(
  "inserted the note",
  vault.insertShieldNote(PAS, payoutCommitment(note), {})
);
await new Promise((r) => setTimeout(r, 8000));
const insertedAt = (await eth.getBlockNumber()) - 30;
await send("revoked the test key", vault.setAuthorized(payee.address, false));
await new Promise((r) => setTimeout(r, 8000));
console.log(`   test key authorized: ${await vault.authorized(payee.address)}`);
console.log(`2. vault note tree holds ${await vault.nextNoteIndex()} notes`);

// 3
const ksNote: Note = {
  nullifier: field(Wallet.createRandom().privateKey),
  secret: field(Wallet.createRandom().privateKey),
  value: PAS.toString(),
  asset: "0",
};
const ksCommitment = commitmentOf(ksNote);
const leaves = await noteLeaves(
  eth,
  vaultAddr,
  insertedAt,
  contractEvents(client, vaultAddr, [INSERTED_TOPIC])
);
let t = performance.now();
const shield = (f: string) =>
  new Uint8Array(
    readFileSync(join(import.meta.dirname, "..", "public", "shield", f))
  );
const spend = await proveSpend(note, leaves, ksCommitment, {
  wasm: shield("shieldnote.wasm"),
  zkey: shield("shieldnote.zkey"),
});
console.log(
  `3. proved in ${Math.round(performance.now() - t)} ms over ${
    leaves.length
  } note(s)`
);

// 4 — through the request format, submitted by a key that never held the note
await send(
  "funded the stranger",
  payee.sendTransaction({ to: stranger.address, value: PAS / 2n })
);
await new Promise((r) => setTimeout(r, 8000));
const words = Array.from({ length: 8 }, (_, i) =>
  BigInt("0x" + spend.proof.slice(2).slice(64 * i, 64 * (i + 1))).toString()
);
const req = decodePayout(
  encodePayout({
    bucket: PAS,
    root: spend.root,
    nullifierHash: spend.nullifierHash,
    ksCommitment: spend.ksCommitment,
    words,
  })
);
const out = await submitPayout(req, vaultAddr, stranger);
console.log(
  `4. stranger ${stranger.address}: ${
    out.status === "sent" ? `sent, gas ${out.gas}` : out.reason
  }`
);
if (out.status !== "sent") process.exit(1);

// 5
const inserts = poolInserts(client, SHIELD_POOL);
let block: number | null = null;
for (let i = 0; i < 30 && block === null; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  block = await findLeafBlock(
    eth,
    SHIELD_POOL,
    ksCommitment,
    insertedAt,
    inserts
  );
}
if (block === null) throw new Error("the pool note never appeared");
const [path] = await notePathsAt(
  eth,
  SHIELD_POOL,
  block,
  [ksCommitment],
  inserts
);
const { root } = await reconstructPath(eth, SHIELD_POOL, ksNote, path, inserts);
console.log(
  `5. pool note at leaf ${
    path.index
  } (block ${block}) reaches the live root ${root.slice(0, 12)}…`
);
client.destroy();
process.exit(0);
