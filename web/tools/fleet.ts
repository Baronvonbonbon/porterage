// A hundred orders against the live contracts, and every lever pulled.
//
//   npx vite-node tools/fleet.ts -- --orders 100
//   npx vite-node tools/fleet.ts -- --orders 6 --lanes 2      (a rehearsal)
//   npx vite-node tools/fleet.ts -- --orders 100 --estimate   (costs only)
//
// `live-order.ts` walks one order through its whole life and prints what it
// sees. This does that a hundred times, on the paths that are not the happy
// one, and adds up what it cost. The point is not that one delivery works —
// that has been true for days — but that a hundred do, that the nine ways an
// order can end all still end correctly, and that the numbers underneath
// (gas, fees, escrow returned) are the real ones rather than the ones in a
// spreadsheet.
//
// Accounts are derived from a seed, so a second run reuses the first run's
// accounts and their leftover funds rather than stranding them. Whatever is
// left goes back to the deployer at the end.
//
// LANES. Orders run several at a time, and each lane owns its own driver,
// session key and venue. That is not for speed alone: two lanes sharing a
// driver would race on that account's nonce, and the failure would look like
// a contract bug rather than the client bug it is.
//
// What this does NOT cover: the Statement Store, Bulletin, WebRTC and the
// host account. Every one of those needs a phone with someone tapping it — a
// Bulletin write costs a prompt each time, measured at 31.5 s then 5.6 s — so
// menus, profiles and bid terms are passed directly here, exactly as
// live-order.ts already does. That boundary is the honest one: this proves
// the contracts and the money, not the transport.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AbiCoder,
  Contract,
  FetchRequest,
  JsonRpcProvider,
  Wallet,
  formatEther,
  keccak256,
  parseEther,
  toUtf8Bytes,
  type TransactionResponse,
} from "ethers";
import { CHAIN } from "../src/config";
import DEPLOYED from "../src/deployed.json";
import ORDERS_ABI from "../src/abi/PorterOrders.json";
import VENUES_ABI from "../src/abi/PorterVenues.json";
import DRIVERS_ABI from "../src/abi/PorterDrivers.json";
import SETTLEMENT_ABI from "../src/abi/PorterSettlement.json";
import DISPUTES_ABI from "../src/abi/PorterDisputes.json";
import RATINGS_ABI from "../src/abi/PorterRatings.json";
import VAULT_ABI from "../src/abi/PorterVault.json";
import {
  b32,
  dropNullifier,
  encLat,
  encLon,
  positionCommit,
  randomSalt,
} from "../src/order/geo";
import { makeDropRequest } from "../src/order/handoff";
import { billFor } from "../src/order/bag";
import { linesOf, totalsOf, type LedgerEntry } from "../src/books/ledger";
import { itemsCsv, ordersCsv } from "../src/books/csv";
import type { Menu } from "../src/order/menu";

const PAS = 10n ** 18n;
const book = DEPLOYED as Record<string, string>;
const abi = AbiCoder.defaultAbiCoder();

// ── arguments ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name: string) => argv.includes(`--${name}`);

const ORDERS = Number(arg("orders", "100"));
const LANES = Number(arg("lanes", "5"));
const SEED = arg("seed", "porterage-fleet-1");
const ESTIMATE_ONLY = has("estimate");
const RPC = arg("rpc", CHAIN.ethRpc);

// ── accounts ────────────────────────────────────────────────────────────────
// A run makes thousands of requests to a public endpoint over twenty minutes,
// and that endpoint will have a bad minute somewhere in there. The first
// hundred-order attempt died on a single 502 at order nine — not a bug in
// anything being tested, and no reason to throw away the run.
//
// So: retry 5xx with a backoff, poll receipts less often (five lanes each
// polling every 500 ms is most of the request volume and most of the reason
// for the throttling), and give each request longer than the default.
const request = new FetchRequest(RPC);
request.timeout = 60_000;
request.retryFunc = async (_req, resp, attempt) => {
  if (attempt >= 6) return false;
  const retryable = resp.statusCode >= 500 || resp.statusCode === 429;
  if (!retryable) return false;
  await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  return true;
};

const eth = new JsonRpcProvider(request, Number(CHAIN.chainId), {
  staticNetwork: true,
});
eth.pollingInterval = 4_000;

// An error inside ethers' own receipt poller surfaces as an unhandled
// rejection, which ends the process — taking a run that is otherwise fine
// with it. Log and carry on: every order is already wrapped in its own
// try/catch, so a genuinely failed order is still counted as failed.
process.on("unhandledRejection", (why) => {
  console.log(`  ! unhandled: ${why instanceof Error ? why.message : String(why)}`);
});

/** Deterministic from the seed, so a re-run finds its own funded accounts. */
function derive(what: string, n: number): Wallet {
  return new Wallet(keccak256(toUtf8Bytes(`${SEED}:${what}:${n}`)), eth);
}

const KEY_FILE = join(homedir(), ".config", "porterage", "deploy-key");
const deployKey = readFileSync(KEY_FILE, "utf8").trim();
const deployer = new Wallet(
  deployKey.startsWith("0x") ? deployKey : `0x${deployKey}`,
  eth
);

// ── the cast (tools/profiles.mjs draws them) ────────────────────────────────
const VENUE_NAMES = [
  "Thistle & Ash", "The Copper Ladle", "Noon Bakehouse", "Saltfeather",
  "Greenmarket Deli", "Ember & Rye", "The Blue Gate", "Marrow Lane Kitchen",
  "Pellet & Pine", "Quayside Grocers",
];
const DRIVER_NAMES = [
  "Wren Halloway", "Ida Marsh", "Tobias Crane", "Nell Ashford", "Otis Vane",
  "Juno Blackwood", "Pim Calloway", "Sable Reyes", "Hollis Frey", "Etta Lark",
];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** A small menu per venue, with a real tax line, priced in planck. */
const MENUS = [
  { items: [["Soup of the day", 0.8], ["Sourdough round", 1.2], ["Barley salad", 1.5]], taxBps: 875 },
  { items: [["Copper stew", 2.4], ["Dumplings, six", 1.8], ["Pickles", 0.6]], taxBps: 700 },
  { items: [["Morning bun", 0.5], ["Rye loaf", 1.1], ["Coffee", 0.7]], taxBps: 0 },
  { items: [["Smoked trout", 3.1], ["Sea salad", 1.4], ["Lemon tart", 1.2]], taxBps: 1000 },
  { items: [["Deli board", 2.9], ["Olives", 0.7], ["Flatbread", 0.6]], taxBps: 875 },
] as const;

// ── bookkeeping ─────────────────────────────────────────────────────────────
//
// Two kinds of money leave an account here and they must never be added up
// together. GAS is paid to the chain for including a transaction: it is a
// function of how busy the chain is and of nothing Porterage decides. A CHARGE
// is a transfer the protocol arranges — the fee on a fare, a driver's
// compensation for being dropped, a dispute bond — and every one of those is a
// number in a contract that governance can change.
//
// Quoting a single "cost per delivery" hides which is which, and the two move
// for completely different reasons. So they are tracked apart, by who paid and
// for what.

type Role = "customer" | "driver" | "venue" | "operator" | "relay";

interface Line {
  txs: number;
  gas: bigint;
  /** Gas in PAS: gasUsed × the price at the time. Paid to the chain. */
  gasCost: bigint;
  /** A protocol charge: a number in a contract, which governance can change. */
  charge: bigint;
  /** Paid to another participant — the goods, the fare, the tip. Not a cost
   *  of using Porterage at all; it is the thing being bought. */
  paid: bigint;
}
const ledger = new Map<string, Line>();
const key = (role: Role | string, action: string) => `${role}\u0000${action}`;

function line(role: Role | string, action: string): Line {
  const k = key(role, action);
  let l = ledger.get(k);
  if (!l) ledger.set(k, (l = { txs: 0, gas: 0n, gasCost: 0n, charge: 0n, paid: 0n }));
  return l;
}

function record(role: Role | string, action: string, gas: bigint, cost: bigint) {
  const l = line(role, action);
  l.txs++;
  l.gas += gas;
  l.gasCost += cost;
}

/** A protocol charge: paid BY someone, to the protocol, not to the chain. */
function charge(role: Role | string, action: string, amount: bigint) {
  line(role, action).charge += amount;
}

/** A payment to another participant: the goods, the fare, the tip. */
function paid(role: Role | string, action: string, amount: bigint) {
  line(role, action).paid += amount;
}

/** Send, wait, and remember who paid what for it. */
async function send(
  role: Role | string,
  action: string,
  tx: Promise<TransactionResponse>
) {
  const sent = await tx;
  const rec = await sent.wait();
  if (!rec) throw new Error(`${action}: no receipt`);
  if (rec.status === 0) throw new Error(`${action}: reverted (${sent.hash})`);
  record(role, action, rec.gasUsed, rec.gasUsed * (rec.gasPrice ?? 0n));
  return rec;
}

const c = {
  orders: (w: Wallet | JsonRpcProvider) =>
    new Contract(book.orders, ORDERS_ABI as never, w),
  venues: (w: Wallet | JsonRpcProvider) =>
    new Contract(book.venues, VENUES_ABI as never, w),
  drivers: (w: Wallet | JsonRpcProvider) =>
    new Contract(book.drivers, DRIVERS_ABI as never, w),
  settlement: (w: Wallet | JsonRpcProvider) =>
    new Contract(book.settlement, SETTLEMENT_ABI as never, w),
  disputes: (w: Wallet | JsonRpcProvider) =>
    new Contract(book.disputes, DISPUTES_ABI as never, w),
  ratings: (w: Wallet | JsonRpcProvider) =>
    new Contract(book.ratings, RATINGS_ABI as never, w),
  vault: (w: Wallet | JsonRpcProvider) =>
    new Contract(book.vault, VAULT_ABI as never, w),
};

const LOCATION_TYPES = {
  LocationAttestation: [
    { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" },
    { name: "actor", type: "address" }, { name: "lat", type: "int32" },
    { name: "lon", type: "int32" }, { name: "timestamp", type: "uint64" },
  ],
};
const DRIVER_COMMIT_TYPES = {
  DriverCommitAttestation: [
    { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" },
    { name: "actor", type: "address" }, { name: "posCommit", type: "bytes32" },
    { name: "timestamp", type: "uint64" },
  ],
};

// ── scenarios ───────────────────────────────────────────────────────────────
// The nine ways an order ends. The mix is deliberately not uniform: deliveries
// are what the system is for, and the rest are the paths that move money
// without one, which is where the bugs live.
type Kind =
  | "delivered"
  | "cancelled-open"
  | "cancelled-assigned"
  | "abandoned"
  | "timed-out"
  | "disputed-customer"
  | "disputed-driver";

function plan(n: number): Kind[] {
  const mix: [Kind, number][] = [
    ["delivered", 0.70],
    ["cancelled-open", 0.08],
    ["cancelled-assigned", 0.06],
    ["abandoned", 0.06],
    ["timed-out", 0.02],
    ["disputed-customer", 0.04],
    ["disputed-driver", 0.04],
  ];
  const out: Kind[] = [];
  for (const [kind, share] of mix) {
    for (let i = 0; i < Math.round(share * n); i++) out.push(kind);
  }
  while (out.length < n) out.push("delivered");
  out.length = n;
  // Interleave, so a lane does not run all of one kind in a row and a failure
  // late in the run is not confined to one scenario.
  const shuffled = out
    .map((k, i) => [k, (i * 7919) % n] as const)
    .sort((a, b) => a[1] - b[1])
    .map(([k]) => k);

  // Except the timeouts, which go first. Each one parks its lane for ten
  // minutes waiting for a deadline the contract will not let us shorten; at
  // the front of the queue that wait happens while the other lanes work,
  // instead of adding ten minutes to the end of the run.
  const waits = shuffled.filter((k) => k === "timed-out");
  const rest = shuffled.filter((k) => k !== "timed-out");
  return [...waits, ...rest];
}

interface Lane {
  n: number;
  driver: Wallet;
  session: Wallet;
  venueOp: Wallet;
  venueId: bigint;
  at: { lat: number; lon: number };
  name: string;
  menu: (typeof MENUS)[number];
}

interface Outcome {
  order: number;
  kind: Kind;
  orderId?: bigint;
  ok: boolean;
  ms: number;
  note?: string;
}

const DROP = { lat: 37_784_900, lon: -122_419_400 };
/** PorterOrders.MIN_WINDOW — ten minutes, and not negotiable from here. */
const MIN_WINDOW = 600n;

/** The contract's own fee parameters, read once at the start of the run. */
let params = { feeBps: 0n, assignedCancelBps: 0n, disputeBond: 0n };

/** The order id, from the OrderCreated log of the transaction that made it. */
function orderIdOf(rec: { logs: readonly { topics: readonly string[]; data: string }[] }): bigint {
  const iface = new Contract(book.orders, ORDERS_ABI as never, eth).interface;
  for (const log of rec.logs) {
    const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    if (parsed?.name === "OrderCreated") return parsed.args[0] as bigint;
  }
  throw new Error("createOrder emitted no OrderCreated");
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One order, start to whichever finish its scenario calls for. */
async function runOrder(lane: Lane, kind: Kind, index: number): Promise<Outcome> {
  const t0 = Date.now();
  const customer = derive("customer", index);
  const ords = c.orders(customer);
  const salt = randomSalt();

  // Small values on purpose: the escrow is float, and float that is not
  // needed is balance nobody can spend for the length of the run.
  const goods = parseEther("0.30");
  const tip = parseEther("0.05");
  const maxFare = parseEther("0.40");
  const fare = parseEther("0.25");
  // The contract's own floor is MIN_WINDOW, ten minutes, and it is right to
  // have one: a window short enough to test with would be a window short
  // enough to strand a driver in traffic. So a timeout test costs ten real
  // minutes, and those orders are scheduled first (see `plan`) so the wait
  // overlaps every other lane's work rather than extending the run.
  const pickupWindow = kind === "timed-out" ? MIN_WINDOW : 0n;

  // The id comes out of the receipt, NOT from reading `nextOrderId` first.
  // Five lanes create orders at once; a counter read a moment before the send
  // is another lane's order by the time this one lands, and every later call
  // then fails with "not-customer" — which reads like an authorization bug
  // and is really a race in this harness.
  const created = await send(
    "customer",
    "createOrder",
    ords.createOrder(
      lane.venueId,
      b32(positionCommit(DROP, salt)),
      goods,
      tip,
      maxFare,
      pickupWindow,
      0n,
      { value: goods + tip }
    )
  );
  const orderId = orderIdOf(created);

  if (kind === "cancelled-open") {
    await send("customer", "cancelOpen", ords.cancelOpen(orderId));
    return { order: index, kind, orderId, ok: true, ms: Date.now() - t0 };
  }

  // ── the auction ──
  const bidSalt = keccak256(crypto.getRandomValues(new Uint8Array(32)));
  const bidHash = (await c.orders(eth).bidHashOf(
    orderId,
    lane.driver.address,
    fare,
    bidSalt
  )) as string;
  const revoke = keccak256(crypto.getRandomValues(new Uint8Array(32)));
  await send(
    "driver",
    "commitBid",
    c.orders(lane.session).commitBid(
      orderId,
      bidHash,
      keccak256(abi.encode(["bytes32"], [revoke]))
    )
  );
  await send(
    "customer",
    "acceptSealedBid",
    ords.acceptSealedBid(orderId, lane.driver.address, fare, bidSalt, {
      value: fare,
    })
  );

  if (kind === "cancelled-assigned") {
    await send("customer", "cancelAssigned", ords.cancelAssigned(orderId));
    // The driver is compensated for having been dropped after agreeing a
    // price. It comes out of the fare the customer had already escrowed.
    charge(
      "customer",
      "compensation to a dropped driver",
      (fare * params.assignedCancelBps) / 10_000n
    );
    return { order: index, kind, orderId, ok: true, ms: Date.now() - t0 };
  }
  if (kind === "abandoned") {
    await send(
      "driver",
      "abandonOrder",
      c.orders(lane.driver).abandonOrder(orderId)
    );
    return { order: index, kind, orderId, ok: true, ms: Date.now() - t0 };
  }
  if (kind === "timed-out") {
    // Wall-clock, because the chain's clock is the chain's. The window was
    // set to 60 s above precisely so this wait is a minute and not an hour.
    await sleep(Number(MIN_WINDOW + 20n) * 1000);
    await send(
      "customer",
      "reopenTimedOut",
      ords.reopenTimedOut(orderId)
    );
    const status = Number(await c.orders(eth).statusOf(orderId));
    return {
      order: index, kind, orderId, ok: status === 1, ms: Date.now() - t0,
      note: `back to status ${status}`,
    };
  }

  // ── pickup: both sides sign the venue's own pin ──
  const { chainId } = await eth.getNetwork();
  const domain = {
    name: "PorterSettlement",
    version: "1",
    chainId,
    verifyingContract: book.settlement,
  };
  const now = BigInt(Math.floor(Date.now() / 1000));
  const vAtt = { orderId, phase: 1, actor: lane.venueOp.address, lat: lane.at.lat, lon: lane.at.lon, timestamp: now };
  const dAtt = { orderId, phase: 1, actor: lane.driver.address, lat: lane.at.lat, lon: lane.at.lon, timestamp: now };
  const vSig = await lane.venueOp.signTypedData(domain, LOCATION_TYPES, vAtt);
  const dSig = await lane.session.signTypedData(domain, LOCATION_TYPES, dAtt);
  await send(
    "driver",
    "confirmPickup",
    c.settlement(lane.session).confirmPickup(dAtt, dSig, vAtt, vSig)
  );

  // ── disputes happen after pickup, with the goods in hand ──
  if (kind === "disputed-customer" || kind === "disputed-driver") {
    const forCustomer = kind === "disputed-customer";
    const bond = (await c.disputes(eth).disputeBond()) as bigint;
    const disputeId = (await c.disputes(eth).nextDisputeId()) as bigint;
    await send(
      "customer",
      "openDispute",
      c.disputes(customer).openDispute(orderId, `fleet:${index}`, { value: bond })
    );
    await send(
      "operator",
      "resolveDispute",
      c.disputes(deployer).resolve(
        disputeId,
        forCustomer ? 10_000 : 0, // the whole escrow one way or the other
        true, // the opener is the customer and is acting in good faith
        forCustomer, // a strike only when the driver was at fault
        0n // no stake slashed: these drivers post none
      )
    );
    if (params.disputeBond > 0n) {
      // Refunded to an opener who wins, forfeited to the treasury otherwise.
      charge("customer", "dispute bond", forCustomer ? 0n : params.disputeBond);
    }
    const status = Number(await c.orders(eth).statusOf(orderId));
    return {
      order: index, kind, orderId, ok: true, ms: Date.now() - t0,
      note: `${forCustomer ? "customer" : "driver"} won, status ${status}`,
    };
  }

  // ── the door: the driver signs a commitment it cannot read ──
  const request = makeDropRequest(orderId, DROP);
  const signedAt = BigInt(Math.floor(Date.now() / 1000));
  const drvAtt = {
    orderId, phase: 2, actor: lane.driver.address,
    posCommit: request.payload.posCommit, timestamp: signedAt,
  };
  const drvSig = await lane.session.signTypedData(
    domain,
    DRIVER_COMMIT_TYPES,
    drvAtt
  );

  const radius = Number(await c.settlement(eth).dropoffRadiusMeters());
  const zk = (f: string) => join(import.meta.dirname, "..", "public", "zk", f);
  const snarkjs = await import("snarkjs");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    {
      orderId: orderId.toString(),
      dropCommit: positionCommit(DROP, salt).toString(),
      driverCommit: BigInt(request.payload.posCommit).toString(),
      radiusMeters: String(radius),
      nullifier: dropNullifier(salt, orderId).toString(),
      custLatEnc: encLat(DROP.lat).toString(),
      custLonEnc: encLon(DROP.lon).toString(),
      salt: salt.toString(),
      drvLatEnc: encLat(DROP.lat).toString(),
      drvLonEnc: encLon(DROP.lon).toString(),
      drvSalt: request.driverSalt.toString(),
    },
    zk("proximity.wasm"),
    zk("proximity.zkey")
  );
  const packed = abi.encode(Array(8).fill("uint256"), [
    proof.pi_a[0], proof.pi_a[1],
    proof.pi_b[0][1], proof.pi_b[0][0],
    proof.pi_b[1][1], proof.pi_b[1][0],
    proof.pi_c[0], proof.pi_c[1],
  ]);
  await send(
    "customer",
    "confirmDropoffZK",
    c.settlement(customer).confirmDropoffZK(drvAtt, drvSig, packed, publicSignals)
  );

  // ── the rating, which only a delivered order may cast ──
  await send(
    "customer",
    "rate",
    c.ratings(customer).rate(orderId, 4 + (index % 2), 3 + (index % 3))
  );

  // What the delivery moved. The protocol's own cut is the fee on the fare
  // and nothing else: not the goods, not the tip, not the tax.
  const fee = (fare * params.feeBps) / 10_000n;
  charge("driver", "protocol fee on the fare", fee);
  paid("customer", "goods to the venue", goods);
  paid("customer", "fare to the driver", fare);
  paid("customer", "tip to the driver", tip);

  const status = Number(await c.orders(eth).statusOf(orderId));
  return {
    order: index, kind, orderId, ok: status === 4, ms: Date.now() - t0,
    note: `status ${status}`,
  };
}

// ── setup ───────────────────────────────────────────────────────────────────
/** The accounts a lane acts from, before anything has been registered. */
function laneAccounts(n: number) {
  return {
    driver: derive("driver", n),
    session: derive("session", n),
    venueOp: derive("venueop", n),
  };
}

async function ensureLanes(): Promise<Lane[]> {
  const lanes: Lane[] = [];
  for (let n = 0; n < LANES; n++) {
    const { driver, session, venueOp } = laneAccounts(n);
    const name = VENUE_NAMES[n % VENUE_NAMES.length];
    // Venues sit a few hundred metres apart so they are distinguishable on a
    // map without leaving the settlement radius of the fixture drop.
    const at = { lat: 37_774_900 + n * 300, lon: -122_419_400 + n * 300 };

    if (!(await c.drivers(eth).drivers(driver.address)).registered) {
      await send(
        "driver",
        "registerDriver",
        c.drivers(driver).registerWithSessionKey(
          `fixtures/profiles/driver-${slug(DRIVER_NAMES[n % DRIVER_NAMES.length])}.svg`,
          session.address
        )
      );
    }

    let venueId = 0n;
    const owned = await c
      .venues(eth)
      .venuesByOperator(venueOp.address, 0)
      .catch(() => null);
    if (owned !== null) {
      venueId = BigInt(owned as bigint);
    } else {
      const next = (await c.venues(eth).nextVenueId()) as bigint;
      await send(
        "venue",
        "registerVenue",
        c.venues(venueOp).registerVenue(
          at.lat, at.lon, venueOp.address, venueOp.address,
          `fixtures/profiles/venue-${slug(name)}.svg`
        )
      );
      venueId = next;
    }

    lanes.push({
      n, driver, session, venueOp, venueId, at, name,
      menu: MENUS[n % MENUS.length],
    });
  }
  return lanes;
}

/**
 * Top a whole set of accounts up to their targets, in one go.
 *
 * One at a time, this is 105 transactions each waiting for its own receipt —
 * twenty minutes of a hundred-order run spent funding it. They all come from
 * the deployer, so they cannot simply be fired in parallel: ethers would ask
 * for the same nonce each time and all but one would be rejected. Numbering
 * them by hand is what makes the parallel send legal.
 */
async function fundAll(
  targets: { w: Wallet; target: bigint; label: string }[]
): Promise<bigint> {
  const balances = await Promise.all(
    targets.map((t) => eth.getBalance(t.w.address))
  );
  const need = targets
    .map((t, i) => ({ ...t, amount: t.target - balances[i] }))
    .filter((t) => t.amount > 0n);
  if (!need.length) return 0n;

  let nonce = await deployer.getNonce();
  const sent = await Promise.all(
    need.map((t, i) =>
      deployer.sendTransaction({
        to: t.w.address,
        value: t.amount,
        nonce: nonce + i,
      })
    )
  );
  const recs = await Promise.all(sent.map((x) => x.wait()));
  let total = 0n;
  recs.forEach((r, i) => {
    if (!r || r.status === 0) throw new Error(`funding ${need[i].label} failed`);
    record("operator", "fundAccount", r.gasUsed, r.gasUsed * (r.gasPrice ?? 0n));
    total += need[i].amount;
  });
  console.log(`   topped up ${need.length} accounts with ${formatEther(total)} PAS`);
  return total;
}

// ── the global levers, which cannot run inside a lane ───────────────────────
async function pullGlobalLevers(lanes: Lane[]) {
  const out: string[] = [];

  // The relay fee curve: a read, across its whole climb.
  const cap = parseEther("0.02");
  const floorBps = (await c.orders(eth).relayFeeFloorBps()) as bigint;
  const climb = (await c.orders(eth).relayFeeClimbSecs()) as bigint;
  const at0 = (await c.orders(eth).relayFeeAt(cap, 1000n, 1000n)) as bigint;
  const mid = (await c.orders(eth).relayFeeAt(cap, 1000n, 1000n + climb / 2n)) as bigint;
  const end = (await c.orders(eth).relayFeeAt(cap, 1000n, 1000n + climb)) as bigint;
  const rising = at0 < mid && mid < end && end === cap;
  out.push(
    `fee curve: ${floorBps} bps floor over ${climb} s — ` +
      `${formatEther(at0)} → ${formatEther(mid)} → ${formatEther(end)} PAS, ` +
      (rising ? "rises to the cap and stops" : "DID NOT RISE AS SPECIFIED")
  );
  if (!rising) throw new Error("relayFeeAt is not monotonic to its cap");

  // Shielding. This runs AFTER the orders, not inside one, because a note is
  // a fixed bucket — the smallest is 1 PAS — and a single fare is a fraction
  // of that. A driver has to have earned its way to a bucket before it can
  // take one out of sight, which is exactly how it works in the app.
  const BN254_R =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const bucket = (await c.vault(eth).shieldBuckets(0)) as bigint;
  let shielded = 0n;
  let notes = 0;
  for (const lane of lanes) {
    const bal = (await c.vault(eth).balanceOf(lane.driver.address)) as bigint;
    if (bal < bucket) continue;
    await send(
      "driver",
      "insertShieldNote",
      c.vault(lane.driver).insertShieldNote(
        bucket,
        BigInt(keccak256(toUtf8Bytes(`${SEED}:note:${lane.n}`))) % BN254_R
      )
    );
    shielded += bucket;
    notes++;
  }
  out.push(
    notes
      ? `shielded ${formatEther(shielded)} PAS of driver earnings into ${notes} note(s) of ${formatEther(bucket)} PAS`
      : `shielding skipped: no driver reached the ${formatEther(bucket)} PAS bucket`
  );

  // The books. Entirely off-chain, and included here because the sharp end of
  // a delivery app's accounting is tax: `orderValue` is goods PLUS the
  // vendor's named charges, so a venue is paid tax it must remit, and if the
  // split is not frozen at the moment of sale it cannot be recovered later —
  // the menu it was computed from will have changed.
  out.push(...booksLever());

  // The stop button. Last, and put back immediately: this is the live app.
  const pause = new Contract(
    book.pauseRegistry,
    [
      "function paused(uint8) view returns (bool)",
      "function pause(uint8)",
      "function unpause(uint8)",
    ],
    deployer
  );
  await send("operator", "pause", pause.pause(0));
  let refused = false;
  try {
    await c.orders(derive("customer", 0)).createOrder.staticCall(
      lanes[0].venueId, b32(1n), 1n, 0n, 1n, 0n, 0n, { value: 1n }
    );
  } catch {
    refused = true;
  }
  await send("operator", "unpause", pause.unpause(0));
  const running = !(await pause.paused(0));
  out.push(
    `pause registry: orders ${refused ? "refused new orders while paused" : "DID NOT REFUSE"}, ` +
      `${running ? "running again" : "STILL PAUSED"}`
  );
  if (!refused || !running) throw new Error("the pause lever did not behave");

  return out;
}


/** Bill a basket from each fixture menu, freeze it, and export both CSVs. */
function booksLever(): string[] {
  const out: string[] = [];
  const entries: LedgerEntry[] = [];

  MENUS.forEach((m, n) => {
    const menu: Menu = {
      name: VENUE_NAMES[n % VENUE_NAMES.length],
      items: m.items.map(([name, pas], i) => ({
        id: `i${i}`,
        name: name as string,
        price: BigInt(Math.round((pas as number) * 1e4)) * (PAS / 10_000n),
      })),
      tax: m.taxBps ? [{ name: "Sales tax", bps: m.taxBps }] : [],
    };
    // Two of the first item, one of the second: enough that a per-unit price
    // and a line total are different numbers and a mix-up would show.
    const picked = new Map([["i0", 2], ["i1", 1]]);
    const bill = billFor(menu, picked);
    const frozen = linesOf(bill);

    if (BigInt(frozen.goods) + BigInt(frozen.taxTotal) !== BigInt(frozen.total))
      throw new Error(`${menu.name}: goods + tax does not equal the total`);
    if (m.taxBps && frozen.tax[0]?.bps !== m.taxBps)
      throw new Error(`${menu.name}: the tax rate was not frozen with the sale`);
    const expectTax = (BigInt(frozen.goods) * BigInt(m.taxBps)) / 10_000n;
    if (BigInt(frozen.taxTotal) !== expectTax)
      throw new Error(`${menu.name}: tax is ${frozen.taxTotal}, expected ${expectTax}`);

    entries.push({
      kind: "sale", orderId: String(1000 + n), at: Date.now(),
      venueId: String(n + 1), venue: menu.name, symbol: "PAS", ...frozen,
    });
    entries.push({
      kind: "earning", orderId: String(1000 + n), at: Date.now(),
      fare: (PAS / 4n).toString(), tip: (PAS / 20n).toString(),
      fee: ((PAS / 4n) * 250n / 10_000n).toString(),
      net: (PAS / 4n - (PAS / 4n) * 250n / 10_000n + PAS / 20n).toString(),
      symbol: "PAS",
    });
  });

  const orders = ordersCsv(entries);
  const items = itemsCsv(entries);
  const bodyRows = orders.trim().split("\r\n").length - 1;
  if (bodyRows !== entries.length)
    throw new Error(`orders.csv has ${bodyRows} rows for ${entries.length} entries`);
  if (!orders.includes("\r\n"))
    throw new Error("the CSV is not CRLF, which spreadsheets mangle");
  if (/\b\d{15,}\b/.test(orders))
    throw new Error("the CSV is emitting raw wei; a spreadsheet will round it");

  const totals = totalsOf(entries);
  out.push(
    `books: ${MENUS.length} menus billed, tax frozen with its rate on every sale; ` +
      `orders.csv ${bodyRows} rows, items.csv ${items.trim().split("\r\n").length - 1} rows, ` +
      `CRLF and decimal PAS`
  );
  out.push(
    `books totals: ${totals.orders} rows, ` +
      `${formatEther(totals.goods)} goods + ${formatEther(totals.tax)} tax ` +
      `= ${formatEther(totals.total)} PAS billed, ` +
      `${formatEther(totals.net)} PAS net to drivers`
  );
  return out;
}

// ── the run ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Porterage fleet — ${ORDERS} orders, ${LANES} lanes, seed "${SEED}"`);
  console.log(`   rpc ${RPC}`);
  console.log(`   orders ${book.orders}`);
  const opening = await eth.getBalance(deployer.address);
  console.log(`   deployer ${deployer.address} holds ${formatEther(opening)} PAS\n`);

  const kinds = plan(ORDERS);
  const tally = kinds.reduce<Record<string, number>>(
    (a, k) => ((a[k] = (a[k] ?? 0) + 1), a),
    {}
  );
  console.log("The plan:");
  for (const [k, n] of Object.entries(tally)) console.log(`   ${String(n).padStart(4)}  ${k}`);

  // Escrow float: goods + tip + fare + gas, per order in flight at once.
  const perOrder = parseEther("1.1");
  const float = perOrder * BigInt(LANES) * 2n;
  const gasGuess = parseEther("1.0") * BigInt(ORDERS);
  console.log(
    `\nEstimate: about ${formatEther(gasGuess)} PAS of gas, plus ${formatEther(float)} PAS of float that comes back.`
  );
  if (ESTIMATE_ONLY) return;
  if (opening < gasGuess + float) {
    throw new Error(
      `deployer holds ${formatEther(opening)} PAS; this run wants about ${formatEther(gasGuess + float)}`
    );
  }

  // Funding comes first, and not as a matter of taste: an account with no
  // balance cannot pay for its own registration, and the node rejects that
  // transaction as malformed rather than as underfunded — "Invalid
  // Transaction", with nothing in it about money.
  console.log("\nFunding the accounts this run will act from…");
  const wants: { w: Wallet; target: bigint; label: string }[] = [];
  for (let n = 0; n < LANES; n++) {
    const { driver, session, venueOp } = laneAccounts(n);
    wants.push({ w: driver, target: parseEther("0.6"), label: `driver ${n}` });
    wants.push({ w: session, target: parseEther("0.9"), label: `session ${n}` });
    wants.push({ w: venueOp, target: parseEther("0.3"), label: `venue ${n}` });
  }
  for (let i = 0; i < ORDERS; i++) {
    wants.push({ w: derive("customer", i), target: parseEther("1.5"), label: `customer ${i}` });
  }
  await fundAll(wants);

  params = {
    feeBps: BigInt(await c.orders(eth).feeBps()),
    assignedCancelBps: BigInt(await c.orders(eth).assignedCancelBps()),
    disputeBond: BigInt(await c.disputes(eth).disputeBond()),
  };
  console.log(
    `\nFee parameters on chain: ${params.feeBps} bps on the fare, ` +
      `${params.assignedCancelBps} bps compensation, ` +
      `${formatEther(params.disputeBond)} PAS dispute bond`
  );

  console.log("\nRegistering venues and drivers…");
  const lanes = await ensureLanes();
  for (const l of lanes)
    console.log(`   lane ${l.n}: venue #${l.venueId} ${l.name}, driver ${l.driver.address.slice(0, 10)}…`);

  console.log(`\nRunning ${ORDERS} orders across ${LANES} lanes…\n`);
  const started = Date.now();
  const results: Outcome[] = [];
  let next = 0;
  await Promise.all(
    lanes.map(async (lane) => {
      for (;;) {
        const i = next++;
        if (i >= ORDERS) return;
        const kind = kinds[i];
        try {
          const r = await runOrder(lane, kind, i);
          results.push(r);
          console.log(
            `  ${String(results.length).padStart(3)}/${ORDERS}  #${r.orderId}  ${kind.padEnd(19)} ` +
              `${(r.ms / 1000).toFixed(1)}s  ${r.note ?? ""}`
          );
        } catch (e) {
          const note = e instanceof Error ? e.message : String(e);
          results.push({ order: i, kind, ok: false, ms: 0, note });
          console.log(`  ${String(results.length).padStart(3)}/${ORDERS}  ${kind.padEnd(19)} FAILED  ${note}`);
        }
      }
    })
  );

  console.log("\nPulling the global levers…");
  const levers = await pullGlobalLevers(lanes);
  for (const l of levers) console.log(`   ${l}`);

  // ── sweep ──
  console.log("\nSweeping what is left back to the deployer…");
  // Each of these is a different account, so there is no shared nonce and they
  // can simply go at once.
  const dust = parseEther("0.03");
  const sweepGas = 25_000n;
  const price = (await eth.getFeeData()).gasPrice ?? 0n;
  const wallets = Array.from({ length: ORDERS }, (_, i) => derive("customer", i));
  const left = await Promise.all(wallets.map((w) => eth.getBalance(w.address)));
  const worth = wallets
    .map((w, i) => ({ w, value: left[i] - sweepGas * price }))
    .filter((x, i) => left[i] > dust && x.value > 0n);
  const swept = await Promise.allSettled(
    worth.map((x) =>
      x.w
        .sendTransaction({ to: deployer.address, value: x.value, gasLimit: sweepGas })
        .then((t) => t.wait())
    )
  );
  let returned = 0n;
  swept.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value?.status === 1) {
      returned += worth[i].value;
      record("operator", "sweepBack", r.value.gasUsed, r.value.gasUsed * (r.value.gasPrice ?? 0n));
    }
  });
  console.log(`   ${formatEther(returned)} PAS returned`);

  // ── the report ──
  const closing = await eth.getBalance(deployer.address);
  const ok = results.filter((r) => r.ok).length;
  const elapsed = (Date.now() - started) / 1000;

  console.log(`\n${"─".repeat(64)}`);
  console.log(`${ok}/${ORDERS} orders ended as planned, in ${(elapsed / 60).toFixed(1)} min`);
  console.log(`${"─".repeat(64)}`);
  const byKind: Record<string, { n: number; ok: number }> = {};
  for (const r of results) {
    const b = (byKind[r.kind] ??= { n: 0, ok: 0 });
    b.n++;
    if (r.ok) b.ok++;
  }
  for (const [k, v] of Object.entries(byKind))
    console.log(`   ${String(v.ok).padStart(3)}/${String(v.n).padEnd(3)}  ${k}`);

  // ── what it cost, and to whom ──
  //
  // Gas and charges are printed apart on purpose. Gas is the chain's price
  // for including a transaction and has nothing to do with Porterage's
  // design; a charge is a number in a contract. Adding them together would
  // produce a "cost per delivery" that moves when the chain is busy and
  // hides the only part anyone here controls.
  const rows = [...ledger.entries()]
    .map(([k, l]) => {
      const [role, action] = k.split("\u0000");
      return { role, action, ...l };
    })
    .sort((a, b) =>
      a.role === b.role
        ? Number(b.gasCost - a.gasCost)
        : a.role.localeCompare(b.role)
    );

  const pas = (v: bigint) => formatEther(v).padStart(13);
  console.log(`\n${"─".repeat(78)}`);
  console.log("GAS — paid to the chain, per role and action");
  console.log(`${"─".repeat(78)}`);
  console.log(
    `${"role".padEnd(10)}${"action".padEnd(22)}${"txs".padStart(6)}` +
      `${"gas".padStart(13)}${"PAS".padStart(14)}${"PAS each".padStart(13)}`
  );
  let totalGasCost = 0n, totalTx = 0;
  for (const r of rows) {
    if (!r.txs) continue;
    console.log(
      `${r.role.padEnd(10)}${r.action.padEnd(22)}${String(r.txs).padStart(6)}` +
        `${String(r.gas).padStart(13)}${pas(r.gasCost)}` +
        `${formatEther(r.gasCost / BigInt(r.txs)).slice(0, 12).padStart(13)}`
    );
    totalGasCost += r.gasCost;
    totalTx += r.txs;
  }
  console.log(
    `${"".padEnd(32)}${String(totalTx).padStart(6)}${"".padStart(13)}${pas(totalGasCost)}`
  );

  const charged = rows.filter((r) => r.charge > 0n);
  console.log(`\n${"─".repeat(78)}`);
  console.log("CHARGES — the protocol's own numbers, which governance sets");
  console.log(`${"─".repeat(78)}`);
  if (!charged.length) console.log("   none: every protocol charge is currently zero");
  let totalCharge = 0n;
  for (const r of charged) {
    console.log(`${r.role.padEnd(10)}${r.action.padEnd(36)}${pas(r.charge)}`);
    totalCharge += r.charge;
  }
  if (charged.length) console.log(`${"".padEnd(46)}${pas(totalCharge)}`);

  const payments = rows.filter((r) => r.paid > 0n);
  console.log(`\n${"─".repeat(78)}`);
  console.log("PAYMENTS — between participants. Not a cost of using Porterage.");
  console.log(`${"─".repeat(78)}`);
  let totalPaid = 0n;
  for (const r of payments) {
    console.log(`${r.role.padEnd(10)}${r.action.padEnd(36)}${pas(r.paid)}`);
    totalPaid += r.paid;
  }
  if (payments.length) console.log(`${"".padEnd(46)}${pas(totalPaid)}`);

  // Per delivery, which is the number anybody actually asks for.
  const delivered = results.filter((r) => r.ok && r.kind === "delivered").length;
  if (delivered) {
    const perRole: Record<string, bigint> = {};
    for (const r of rows) perRole[r.role] = (perRole[r.role] ?? 0n) + r.gasCost;
    console.log(`\n${"─".repeat(78)}`);
    console.log(`ONE DELIVERY, averaged over ${delivered} of them`);
    console.log(`${"─".repeat(78)}`);
    for (const [role, v] of Object.entries(perRole)) {
      if (role === "operator") continue; // funding and sweeping are this harness, not the product
      console.log(`   ${role.padEnd(10)} ${formatEther(v / BigInt(delivered)).slice(0, 12).padStart(12)} PAS of gas`);
    }
    const feePer = totalCharge / BigInt(delivered);
    const valuePer = totalPaid / BigInt(delivered);
    console.log(`   ${"protocol".padEnd(10)} ${formatEther(feePer).slice(0, 12).padStart(12)} PAS charged`);
    if (valuePer > 0n) {
      const bps = (totalCharge * 1_000_000n) / totalPaid;
      console.log(
        `   on ${formatEther(valuePer).slice(0, 10)} PAS of delivery value — ` +
          `${(Number(bps) / 10_000).toFixed(3)}% effective`
      );
    }
  }

  console.log(
    `\nDeployer: ${formatEther(opening)} → ${formatEther(closing)} PAS ` +
      `(${formatEther(opening - closing)} spent net of the sweep)`
  );

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log(`\n${failed.length} did not end as planned:`);
    for (const f of failed.slice(0, 20)) console.log(`   #${f.order} ${f.kind}: ${f.note}`);
  }

  mkdirSync(join(import.meta.dirname, "..", "..", "fixtures"), { recursive: true });
  const out = join(import.meta.dirname, "..", "..", "fixtures", "fleet-run.json");
  writeFileSync(
    out,
    JSON.stringify(
      {
        at: new Date().toISOString(), orders: ORDERS, lanes: LANES, seed: SEED,
        contracts: { orders: book.orders, settlement: book.settlement, vault: book.vault },
        elapsedSeconds: elapsed, results: results.map((r) => ({ ...r, orderId: r.orderId?.toString() })),
        costs: rows.map((r) => ({
          role: r.role, action: r.action, txs: r.txs,
          gas: r.gas.toString(),
          gasPas: formatEther(r.gasCost),
          chargePas: formatEther(r.charge),
          paidPas: formatEther(r.paid),
        })),
        levers,
      },
      // BigInt has no JSON representation and throws rather than guessing.
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      2
    )
  );
  console.log(`\nWritten to ${out}`);
  if (failed.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    // Let go of the provider, or this never exits.
    //
    // A JsonRpcProvider keeps a polling timer alive, so node's event loop
    // stays open after main() has resolved and the report has been written.
    // Four finished runs were found still resident an hour later, each still
    // polling the same public endpoint — which is very likely part of why the
    // first hundred-order attempt was thrown a 502. A test harness that never
    // exits also cannot be put in CI.
    eth.destroy();
  });
