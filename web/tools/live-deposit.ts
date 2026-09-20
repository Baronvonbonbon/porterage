// Live check of the deposit path, from node (npx vite-node tools/live-deposit.ts).
//
// Sends what the app's top-up sends (Utility.batch_all of Revive.call
// depositNative, value in planck) from a local sr25519 key, then rebuilds each
// note's path with notePathsAt + reconstructPath and checks it reaches the
// pool's live root. Spends 2 PAS into two 1 PAS notes with random secrets.
//
// KEY_FILE: a mnemonic file (default ~/.config/porterage/name-key).

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
import { JsonRpcProvider, getBytes, randomBytes, toBigInt } from "ethers";
import { CHAIN, SHIELD_POOL } from "../src/config";
import {
  POOL,
  BN254_R,
  b32,
  commitmentOf,
  notePathsAt,
  reconstructPath,
  type Note,
} from "../src/shield/pool";
import { poolInserts } from "../src/shield/events";

const HUB_EXTENSIONS = Object.fromEntries(
  [
    "AsPgas",
    "AsScarcity",
    "AsRingAlias",
    "AsDotnsGateway",
    "RestrictOrigins",
  ].map((e) => [e, { value: new Uint8Array([0]) }])
);

const words = readFileSync(
  process.env.KEY_FILE ?? join(homedir(), ".config", "porterage", "name-key"),
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

const field = () => (toBigInt(randomBytes(31)) % BN254_R).toString();
const notes: Note[] = [1n, 1n].map((p) => ({
  nullifier: field(),
  secret: field(),
  value: (p * 10n ** 18n).toString(),
  asset: "0",
}));
const commitments = notes.map(commitmentOf);

const inner = [];
for (const [i, n] of notes.entries()) {
  const data = POOL.encodeFunctionData("depositNative", [b32(commitments[i])]);
  const value = BigInt(n.value) / 10n ** 8n;
  const dry: any = await api.apis.ReviveApi.call(
    origin,
    SHIELD_POOL,
    value,
    undefined,
    undefined,
    getBytes(data)
  );
  if (!dry.result.success || dry.result.value.flags & 1)
    throw new Error(
      `dry run: ${JSON.stringify(dry.result, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v
      )}`
    );
  const w = dry.weight_required;
  const dep =
    dry.storage_deposit.type === "Charge" ? dry.storage_deposit.value : 0n;
  inner.push(
    api.tx.Revive.call({
      dest: SHIELD_POOL,
      value,
      weight_limit: {
        ref_time: (w.ref_time * 6n) / 5n,
        proof_size: (w.proof_size * 6n) / 5n,
      },
      storage_deposit_limit: (dep * 6n) / 5n,
      data: getBytes(data),
    }).decodedCall
  );
}
console.log(`depositing 2 × 1 PAS from ${origin}`);
const r = await api.tx.Utility.batch_all({ calls: inner }).signAndSubmit(
  signer,
  { customSignedExtensions: HUB_EXTENSIONS }
);
if (!r.ok) throw new Error(`failed: ${JSON.stringify(r.dispatchError)}`);
console.log(`included in block ${r.block.number}`);

const inserts = poolInserts(client, SHIELD_POOL);
const paths = await notePathsAt(
  eth,
  SHIELD_POOL,
  r.block.number,
  commitments,
  inserts
);
console.log(
  "indexes",
  paths.map((p) => p.index)
);
for (const [i, n] of notes.entries()) {
  const { root } = await reconstructPath(
    eth,
    SHIELD_POOL,
    n,
    paths[i],
    inserts
  );
  console.log(`note ${i}: path reaches the live root ${root.slice(0, 12)}…`);
}
client.destroy();
process.exit(0);
