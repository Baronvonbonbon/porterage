// The demo venues, on chain.
//
//   node tools/demo-venues.mjs              # say what it would do
//   node tools/demo-venues.mjs --do-it      # register or reopen them
//   node tools/demo-venues.mjs --retire     # close them again
//
// These are the five shops in `tools/demo-set.mjs`, registered so the app has
// something to browse that looks like a delivery app rather than a list of
// "Venue #14" with no menu. Their `metadataURI` is `demo:<slug>`, which the
// app resolves out of its own bundle — no Bulletin, no prompt, no two-week
// expiry (see the comment on DEMO in `src/order/menu.ts`).
//
// THEY ARE MEANT TO BE REMOVABLE, and that is not a promise made in a comment.
// The operator of each is derived from the seed below, so `--retire` closes
// every one of them from this machine, the same way the fleet's twenty were
// closed. Nothing here needs a key anybody has to keep.
//
// `--do-it` is idempotent: a venue already registered to its operator is found
// by asking the registry rather than registered twice, and reopened if it was
// closed. So this is also how the set comes back after a --retire.
//
// Where they are: spread around the pin the app's own fixtures use, close
// enough to be inside a default browse radius and far enough apart that the
// distance column says something.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet, formatEther, keccak256, toUtf8Bytes } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const book = JSON.parse(readFileSync(join(root, "src", "deployed.json"), "utf8"));
const ABI = JSON.parse(readFileSync(join(root, "src", "abi", "PorterVenues.json"), "utf8"));
const MENUS = JSON.parse(readFileSync(join(root, "src", "order", "demo.json"), "utf8"));

/** One seed, written down, because retiring these later depends on it. */
const SEED = "porterage-demo-venues-1";

/** Around the fixtures' pin, a few hundred metres apart. Lat/lon in 1e6 degrees. */
const HOME = { lat: 51_507_400, lon: -127_600 };
const SPREAD = [
  [0, 0],
  [320, 180],
  [-240, 410],
  [500, -260],
  [-180, -520],
];

const RPC = process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";
const eth = new JsonRpcProvider(RPC);
const RETIRE = process.argv.includes("--retire");
const DO_IT = process.argv.includes("--do-it") || RETIRE;

const slugs = Object.keys(MENUS);
const opOf = (n) => new Wallet(keccak256(toUtf8Bytes(`${SEED}:venueop:${n}`)), eth);
const venues = new Contract(book.venues, ABI.abi ?? ABI, eth);

/** What is already on chain for each demo operator. */
const state = [];
for (const [n, slug] of slugs.entries()) {
  const op = opOf(n);
  let id = null;
  try {
    if (Number(await venues.venueCountOf(op.address)) > 0)
      id = await venues.venuesByOperator(op.address, 0);
  } catch {
    /* an operator the registry has never heard of */
  }
  const active = id === null ? false : (await venues.venues(id)).active;
  state.push({ n, slug, op, id, active, name: MENUS[slug].name });
}

console.log(`Demo venues on ${book.venues}\n`);
for (const s of state)
  console.log(
    `   ${s.slug.padEnd(20)} ${s.id === null ? "not registered" : `#${s.id} ${s.active ? "open" : "closed"}`}`
  );

const todo = RETIRE
  ? state.filter((s) => s.id !== null && s.active)
  : state.filter((s) => s.id === null || !s.active);

if (!todo.length) {
  console.log(`\nNothing to do.`);
  eth.destroy();
  process.exit(0);
}

console.log(
  `\n${RETIRE ? "Would close" : "Would register or reopen"} ${todo.length}.`
);
if (!DO_IT) {
  console.log(`This was a dry run. Pass ${RETIRE ? "--retire --do-it" : "--do-it"}.`);
  eth.destroy();
  process.exit(0);
}

// The operators hold nothing between runs, so they are funded as needed.
const deployKey = readFileSync(
  join(homedir(), ".config", "porterage", "deploy-key"),
  "utf8"
).trim();
const deployer = new Wallet(
  deployKey.startsWith("0x") ? deployKey : `0x${deployKey}`,
  eth
);
const GAS_EACH = 10n ** 17n; // 0.1 PAS against a ~26k-gas call

console.log(`\n${RETIRE ? "Closing" : "Opening"}…`);
let done = 0;
for (const s of todo) {
  try {
    if ((await eth.getBalance(s.op.address)) < GAS_EACH / 2n)
      await (
        await deployer.sendTransaction({ to: s.op.address, value: GAS_EACH })
      ).wait();

    const as = new Contract(book.venues, ABI.abi ?? ABI, s.op);
    if (RETIRE) {
      await (await as.setActive(s.id, false)).wait();
      console.log(`   #${s.id} ${s.name} closed`);
    } else if (s.id === null) {
      const next = await venues.nextVenueId();
      const [dLat, dLon] = SPREAD[s.n % SPREAD.length];
      await (
        await as.registerVenue(
          HOME.lat + dLat,
          HOME.lon + dLon,
          s.op.address,
          s.op.address,
          `demo:${s.slug}`
        )
      ).wait();
      s.id = next;
      console.log(`   #${next} ${s.name} registered`);
    } else {
      await (await as.setActive(s.id, true)).wait();
      console.log(`   #${s.id} ${s.name} reopened`);
    }
    done++;
  } catch (e) {
    console.log(`   ${s.name} FAILED: ${e.shortMessage ?? e.message}`);
  }
}

// Written down so removing these later needs no archaeology.
writeFileSync(
  join(root, "..", "fixtures", "demo-venues.json"),
  `${JSON.stringify(
    {
      "//": "Registered by web/tools/demo-venues.mjs. --retire closes them all.",
      seed: SEED,
      registry: book.venues,
      at: new Date().toISOString(),
      venues: state.map((s) => ({
        slug: s.slug,
        name: s.name,
        id: s.id === null ? null : Number(s.id),
        operator: s.op.address,
      })),
    },
    null,
    2
  )}\n`
);

console.log(`\n${done}/${todo.length} done. Deployer holds ${formatEther(await eth.getBalance(deployer.address))} PAS.`);
eth.destroy();
