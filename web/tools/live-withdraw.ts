// Live check of a withdrawal, from node (npx vite-node tools/live-withdraw.ts).
//
// 1. deposits one 1 PAS note (random secrets) from a local sr25519 key, as the app's top-up does
// 2. proves a 0.4 PAS withdrawal to a fresh burner with a change note, as the customer's phone will
// 3. submits `withdraw` from the contract deployer's Ethereum key, as a peer in the funding market will
// 4. checks the burner got the money and the change note's path reaches the live root
//
// KEY_FILE: sr25519 mnemonic for the deposit (default ~/.config/sonde/deploy-key)
// SUBMITTER_KEY_FILE: Ethereum key for submitting (default ~/.config/porterage/deploy-key)

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient, AccountId } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
  entropyToMiniSecret,
  mnemonicToEntropy,
} from "@polkadot-labs/hdkd-helpers";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  formatEther,
  getBytes,
  randomBytes,
  toBigInt,
} from "ethers";
import { CHAIN, SHIELD_POOL } from "../src/config";
import {
  POOL,
  POOL_ABI,
  BN254_R,
  b32,
  commitmentOf,
  notePathsAt,
  reconstructPath,
  type Note,
} from "../src/shield/pool";
import { poolInserts } from "../src/shield/events";
import { proveWithdrawal } from "../src/shield/withdraw";

const HUB_EXTENSIONS = Object.fromEntries(
  [
    "AsPgas",
    "AsScarcity",
    "AsRingAlias",
    "AsDotnsGateway",
    "RestrictOrigins",
  ].map((e) => [e, { value: new Uint8Array([0]) }])
);
const PAS = 10n ** 18n;
const artifacts = async (name: string) =>
  new Uint8Array(
    readFileSync(join(import.meta.dirname, "..", "public", "shield", name))
  );

const words = readFileSync(
  process.env.KEY_FILE ?? join(homedir(), ".config", "sonde", "deploy-key"),
  "utf8"
).trim();
const kp = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(words)))(
  ""
);
const signer = getPolkadotSigner(kp.publicKey, "Sr25519", kp.sign);
const origin = AccountId(CHAIN.ss58Prefix).dec(kp.publicKey);
const client = createClient(getWsProvider(CHAIN.wss));
const api = client.getUnsafeApi();
const eth = new JsonRpcProvider(CHAIN.ethRpc, Number(CHAIN.chainId), {
  staticNetwork: true,
});
const submitter = new Wallet(
  readFileSync(
    process.env.SUBMITTER_KEY_FILE ??
      join(homedir(), ".config", "porterage", "deploy-key"),
    "utf8"
  ).trim(),
  eth
);
const inserts = poolInserts(client, SHIELD_POOL);

const field = () => (toBigInt(randomBytes(31)) % BN254_R).toString();
const note: Note = {
  nullifier: field(),
  secret: field(),
  value: (1n * PAS).toString(),
  asset: "0",
};
const commitment = commitmentOf(note);

// 1. deposit
const data = POOL.encodeFunctionData("depositNative", [b32(commitment)]);
const value = BigInt(note.value) / 10n ** 8n;
const dry: any = await api.apis.ReviveApi.call(
  origin,
  SHIELD_POOL,
  value,
  undefined,
  undefined,
  getBytes(data)
);
const w = dry.weight_required;
const r = await api.tx.Revive.call({
  dest: SHIELD_POOL,
  value,
  data: getBytes(data),
  weight_limit: {
    ref_time: (w.ref_time * 6n) / 5n,
    proof_size: (w.proof_size * 6n) / 5n,
  },
  storage_deposit_limit: ((dry.storage_deposit.value ?? 0n) * 6n) / 5n,
}).signAndSubmit(signer, { customSignedExtensions: HUB_EXTENSIONS });
if (!r.ok)
  throw new Error(`deposit failed: ${JSON.stringify(r.dispatchError)}`);
const [path] = await notePathsAt(
  eth,
  SHIELD_POOL,
  r.block.number,
  [commitment],
  inserts
);
console.log(
  `1. deposited 1 PAS in block ${r.block.number}, leaf ${path.index}`
);

// 2. prove
const burner = Wallet.createRandom();
const withdrawn = (4n * PAS) / 10n;
const change: Note = {
  nullifier: field(),
  secret: field(),
  value: (BigInt(note.value) - withdrawn).toString(),
  asset: "0",
};
let t = performance.now();
const proof = await proveWithdrawal({
  provider: eth,
  pool: SHIELD_POOL,
  note,
  path,
  change,
  recipient: burner.address,
  withdrawnValue: withdrawn,
  fromSubstrate: inserts,
  artifacts,
});
console.log(`2. proved in ${Math.round(performance.now() - t)} ms`);
console.log("   pubSignals:");
const known: Record<string, string> = {
  [commitmentOf(change).toString()]: "change commitment",
  [withdrawn.toString()]: "withdrawn value",
  "128": "tree depth",
  "0": "asset (0 = PAS)",
};
proof.pubSignals.forEach((s, i) =>
  console.log(
    `   [${i}] ${s.length > 20 ? s.slice(0, 16) + "…" : s}  ${known[s] ?? ""}`
  )
);

// 3. submit as a peer
const pool = new Contract(SHIELD_POOL, POOL_ABI, submitter);
const gas = await pool.withdraw.estimateGas(
  proof.pA,
  proof.pB,
  proof.pC,
  proof.pubSignals,
  burner.address
);
const nonce = await eth.getTransactionCount(submitter.address);
t = performance.now();
await pool.withdraw(
  proof.pA,
  proof.pB,
  proof.pC,
  proof.pubSignals,
  burner.address,
  { gasLimit: (gas * 6n) / 5n, nonce }
);
for (
  let i = 0;
  i < 90 && (await eth.getTransactionCount(submitter.address)) <= nonce;
  i++
)
  await new Promise((res) => setTimeout(res, 1000));
console.log(
  `3. submitted from ${
    submitter.address
  }, gas ${gas}, confirmed in ${Math.round(performance.now() - t)} ms`
);

// 4. effects
console.log(
  `4. burner ${burner.address} holds ${formatEther(
    await eth.getBalance(burner.address)
  )} PAS`
);
const head = await eth.getBlockNumber();
let found = -1;
for (let b = head; b > head - 30 && found < 0; b--)
  if ((await inserts(b)).includes(commitmentOf(change))) found = b;
if (found < 0) throw new Error("change note not found in the last 30 blocks");
const [cpath] = await notePathsAt(
  eth,
  SHIELD_POOL,
  found,
  [commitmentOf(change)],
  inserts
);
const { root } = await reconstructPath(
  eth,
  SHIELD_POOL,
  change,
  cpath,
  inserts
);
console.log(
  `   change note at leaf ${
    cpath.index
  } (block ${found}) reaches the live root ${root.slice(0, 12)}…`
);
client.destroy();
process.exit(0);
