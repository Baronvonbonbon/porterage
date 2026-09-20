// Live check of the token path (npx vite-node tools/live-swap.ts).
//
// 1. quotes every accepted token against PAS
// 2. buys USDC with PAS, so the test account holds a stablecoin
// 3. does what the app's one tap does: swap USDC back to PAS and deposit the
//    proceeds as ladder notes, in a single Utility.batch_all
// 4. checks the notes' paths reach the pool's live root
//
// KEY_FILE: sr25519 mnemonic (default ~/.config/sonde/deploy-key)

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AccountId, createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
  entropyToMiniSecret,
  mnemonicToEntropy,
} from "@polkadot-labs/hdkd-helpers";
import { JsonRpcProvider, getBytes, randomBytes, toBigInt } from "ethers";
import { CHAIN, SHIELD_POOL } from "../src/config";
import { TOKENS, formatUnits, tokenOf } from "../src/money/tokens";
import {
  BN254_R,
  POOL,
  b32,
  commitmentOf,
  notePathsAt,
  reconstructPath,
  type Note,
} from "../src/shield/pool";
import { poolInserts } from "../src/shield/events";
import { LADDER_PAS, decompose } from "../src/shield/ladder";

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
  process.env.KEY_FILE ?? join(homedir(), ".config", "sonde", "deploy-key"),
  "utf8"
).trim();
const kp = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(words)))(
  ""
);
const signer = getPolkadotSigner(kp.publicKey, "Sr25519", kp.sign);
const me = AccountId(CHAIN.ss58Prefix).dec(kp.publicKey);
const client = createClient(getWsProvider(CHAIN.wss));
const api = client.getUnsafeApi();
const eth = new JsonRpcProvider(CHAIN.ethRpc, Number(CHAIN.chainId), {
  staticNetwork: true,
});

const PAS_LOCATION = {
  parents: 1,
  interior: { type: "Here", value: undefined },
};
const locationOf = (id: number) => ({
  parents: 0,
  interior: {
    type: "X2",
    value: [
      { type: "PalletInstance", value: 50 },
      { type: "GeneralIndex", value: BigInt(id) },
    ],
  },
});
const quote = async (from: unknown, to: unknown, amt: bigint) =>
  (await api.apis.AssetConversionApi.quote_price_exact_tokens_for_tokens(
    from,
    to,
    amt,
    true
  )) as bigint | undefined;
const submit = async (call: unknown, what: string) => {
  const r = await (
    call as {
      signAndSubmit: (
        s: unknown,
        o: unknown
      ) => Promise<{
        ok: boolean;
        block: { number: number };
        dispatchError?: unknown;
      }>;
    }
  ).signAndSubmit(signer, { customSignedExtensions: HUB_EXTENSIONS });
  if (!r.ok)
    throw new Error(`${what} failed: ${JSON.stringify(r.dispatchError)}`);
  return r.block.number;
};

// 1
console.log("1. quotes (1 PAS buys):");
for (const t of TOKENS) {
  const out = await quote(PAS_LOCATION, locationOf(t.id), 10n ** 10n);
  console.log(
    `   ${t.symbol.padEnd(5)} ${
      out ? formatUnits(out, t.decimals, 4) : "no liquidity"
    }`
  );
}

// 2
const usdc = tokenOf(1337)!;
const buy = await api.tx.AssetConversion.swap_exact_tokens_for_tokens({
  path: [PAS_LOCATION, locationOf(usdc.id)],
  amount_in: 5n * 10n ** 10n, // 5 PAS
  amount_out_min: 1n,
  send_to: me,
  keep_alive: true,
});
console.log(`2. bought USDC in block ${await submit(buy, "buying USDC")}`);
const balance =
  (
    (await api.query.Assets.Account.getValue(usdc.id, me)) as
      | { balance: bigint }
      | undefined
  )?.balance ?? 0n;
const min = (
  (await api.query.Assets.Asset.getValue(usdc.id)) as { min_balance: bigint }
).min_balance;
const held = balance - min; // the account may not be emptied: Token(NotExpendable)
console.log(`   holding ${formatUnits(held, usdc.decimals, 4)} USDC`);

// 3 — one transaction: swap back, then deposit the proceeds as notes
const quoted = (await quote(locationOf(usdc.id), PAS_LOCATION, held))!;
const minOut = (quoted * 9900n) / 10_000n;
const { rungs: allRungs } = decompose(minOut * 10n ** 8n, LADDER_PAS);
const rungs = allRungs.slice(0, 3); // MAX_NOTES_PER_TAP
console.log(
  `3. ${formatUnits(held, usdc.decimals, 4)} USDC quotes at ${
    Number(quoted) / 1e10
  } PAS → notes ${rungs.map((r) => r / 10n ** 18n).join(" + ")}`
);
const field = () => (toBigInt(randomBytes(31)) % BN254_R).toString();
const notes: Note[] = rungs.map((r) => ({
  nullifier: field(),
  secret: field(),
  value: r.toString(),
  asset: "0",
}));
const commitments = notes.map(commitmentOf);
const swapBack = await api.tx.AssetConversion.swap_exact_tokens_for_tokens({
  path: [locationOf(usdc.id), PAS_LOCATION],
  amount_in: held,
  amount_out_min: minOut,
  send_to: me,
  keep_alive: true,
});
const deposits = [];
for (const [i, n] of notes.entries()) {
  const data = POOL.encodeFunctionData("depositNative", [b32(commitments[i])]);
  const value = BigInt(n.value) / 10n ** 8n;
  const dry: any = await api.apis.ReviveApi.call(
    me,
    SHIELD_POOL,
    value,
    undefined,
    undefined,
    getBytes(data)
  );
  const w = dry.weight_required;
  deposits.push(
    api.tx.Revive.call({
      dest: SHIELD_POOL,
      value,
      data: getBytes(data),
      weight_limit: {
        ref_time: (w.ref_time * 6n) / 5n,
        proof_size: (w.proof_size * 6n) / 5n,
      },
      storage_deposit_limit: ((dry.storage_deposit.value ?? 0n) * 6n) / 5n,
    }).decodedCall
  );
}
const block = await submit(
  api.tx.Utility.batch_all({ calls: [swapBack.decodedCall, ...deposits] }),
  "the swap-and-shield batch"
);
console.log(`   swapped and shielded in one transaction, block ${block}`);

// 4
const inserts = poolInserts(client, SHIELD_POOL);
const paths = await notePathsAt(eth, SHIELD_POOL, block, commitments, inserts);
for (const [i, n] of notes.entries()) {
  const { root } = await reconstructPath(
    eth,
    SHIELD_POOL,
    n,
    paths[i],
    inserts
  );
  console.log(
    `4. note ${i} at leaf ${paths[i].index} reaches the live root ${root.slice(
      0,
      12
    )}…`
  );
}
client.destroy();
process.exit(0);
