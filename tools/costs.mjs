// What Porterage costs, per role, per delivery.
//
//   node tools/costs.mjs            # testnet parameters, live
//   node tools/costs.mjs --offline  # contract defaults, no network
//
// WHY THIS IS A TOOL AND NOT A PARAGRAPH IN THE DOCS. Every number here moves:
// gas moves when a contract changes, the protocol fee and the relay fees move
// when governance sets them, and the tip moves when the funding market decides
// it should. A cost written into prose is wrong within a month and nobody
// notices. This reads the gas snapshot the test suite maintains and the fee
// parameters the chain actually holds, and prints what they add up to.
//
// WHAT "AT COST" MEANS HERE, because it is the question that was asked and it
// has a precise answer: the protocol takes `feeBps` of the FARE and nothing
// else — not the goods, not the tip, not the tax. Everything else on this list
// is either gas paid to the chain, or a payment from one participant to
// another (a tip to whoever submits a withdrawal for you), neither of which
// Porterage receives. So the effective service fee is the protocol fee, and
// the rest of this table is the cost of using a blockchain at all.
//
// Gas on Paseo is 1e12 wei a unit, which makes the arithmetic easy and the
// numbers large: 200,000 gas is 0.2 PAS. That is a testnet price and says
// nothing about what this would cost on a chain anyone pays real money on.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const gas = JSON.parse(readFileSync(join(root, "gas-snapshot.json"), "utf8"));
const addresses = JSON.parse(
  readFileSync(join(root, "deployed-addresses.json"), "utf8")
);

/** Paseo's gas price, in wei per unit. */
const GAS_PRICE = 10n ** 12n;
const PAS = 10n ** 18n;

const pas = (wei) => (Number(wei) / Number(PAS)).toFixed(4);
const costOf = (name) => BigInt(gas[name] ?? 0) * GAS_PRICE;

/** Contract defaults, used when the chain can't be reached. */
const DEFAULTS = {
  feeBps: 250n,
  relayServiceFee: 0n,
  withdrawFeeBps: 0n,
  assignedCancelBps: 2000n,
};

async function live() {
  const { JsonRpcProvider, Contract } = await import("ethers");
  const url = process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";
  const provider = new JsonRpcProvider(url);
  const orders = new Contract(
    addresses.orders,
    [
      "function feeBps() view returns (uint16)",
      "function assignedCancelBps() view returns (uint16)",
      "function relayServiceFee(address) view returns (uint96)",
    ],
    provider
  );
  const vault = new Contract(
    addresses.vault,
    [
      "function withdrawFeeBps() view returns (uint16)",
      "function shieldBucketCount() view returns (uint256)",
      "function shieldBuckets(uint256) view returns (uint96)",
    ],
    provider
  );
  const count = Number(await vault.shieldBucketCount());
  const buckets = [];
  for (let i = 0; i < count; i++) buckets.push(await vault.shieldBuckets(i));
  return {
    feeBps: BigInt(await orders.feeBps()),
    assignedCancelBps: BigInt(await orders.assignedCancelBps()),
    relayServiceFee: BigInt(
      await orders.relayServiceFee("0x0000000000000000000000000000000000000000")
    ),
    withdrawFeeBps: BigInt(await vault.withdrawFeeBps()),
    buckets,
  };
}

/** A delivery worth arguing about: 10 PAS of goods, a 1 PAS fare. */
const GOODS = 10n * PAS;
const FARE = PAS;
/** What the funding market asks to submit a withdrawal (web/src/shield/fund.ts). */
const TIP = 3n * 10n ** 17n;

function report(p) {
  const fee = (FARE * p.feeBps) / 10_000n;
  // Shielding is paid once per BUCKET, not once per delivery. A driver taking
  // 1 PAS fares and shielding at 25 PAS pays it once for twenty-five jobs, so
  // charging it per delivery overstates the cost by that factor. The biggest
  // bucket a role can reach with one delivery's earnings is the honest
  // divisor; default to the smallest bucket when the chain is unreachable.
  const bucket = p.buckets?.length ? p.buckets[p.buckets.length - 1] : PAS;
  const perShield = costOf("vault.insertShieldNote");
  const driverJobs = FARE > 0n ? bucket / FARE : 1n;
  const venueJobs = GOODS > 0n ? bucket / GOODS : 1n;
  const share = (wei, jobs) => (jobs > 1n ? wei / jobs : wei);

  const rows = (title, once, each) => {
    console.log(`\n${title}`);
    let total = 0n;
    for (const [what, wei, note] of each) {
      total += wei;
      console.log(
        `  ${what.padEnd(34)} ${pas(wei).padStart(9)} PAS${note ? `   ${note}` : ""}`
      );
    }
    console.log(`  ${"".padEnd(34)} ${"\u2014".padStart(9)}`);
    console.log(`  ${"per delivery".padEnd(34)} ${pas(total).padStart(9)} PAS`);
    for (const [what, wei] of once) {
      console.log(
        `  ${what.padEnd(34)} ${pas(wei).padStart(9)} PAS   once, ever`
      );
    }
    return total;
  };

  console.log(`Porterage, what a delivery costs each side`);
  console.log(`  goods ${pas(GOODS)} PAS, fare ${pas(FARE)} PAS`);
  console.log(`  protocol fee ${p.feeBps} bps of the fare only`);
  console.log(`  gas at ${GAS_PRICE} wei a unit (Paseo)`);

  const customer = rows(
    "CUSTOMER",
    [],
    [
      ["shield a note", 0n, "Substrate fee, host-signed; not EVM gas"],
      ["fund a burner: the proof", 0n, "on the phone, 2-7 s, no gas"],
      ["fund a burner: the tip", TIP, "to whoever submits it; not ours"],
      ["create the order", costOf("orders.createOrder")],
      ["accept a bid", costOf("orders.acceptSealedBid")],
      ["prove proximity at the door", costOf("settlement.confirmDropoffZK")],
      ["rate the driver", costOf("ratings.rate")],
    ]
  );

  const driver = rows(
    "DRIVER",
    [["register", costOf("drivers.register")]],
    [
      ["bid", costOf("orders.commitBid")],
      ["cosign the pickup", costOf("settlement.confirmPickup")],
      [
        "shield the earnings",
        share(perShield, driverJobs),
        `1/${driverJobs} of a ${pas(bucket)} PAS shield`,
      ],
    ]
  );

  const venue = rows(
    "VENUE",
    [["register", costOf("venues.registerVenue")]],
    [
      ["publish a menu", 0n, "Bulletin, host-signed; a tap, not gas"],
      ["cosign the pickup", 0n, "the driver submits it"],
      [
        "shield the takings",
        share(perShield, venueJobs),
        `1/${venueJobs} of a ${pas(bucket)} PAS shield`,
      ],
    ]
  );

  console.log("\nWHAT PORTERAGE ITSELF TAKES");
  const take = (what, wei, note) =>
    console.log(`  ${what.padEnd(34)} ${pas(wei).padStart(9)} PAS   ${note}`);
  take("protocol fee", fee, `${p.feeBps} bps of the ${pas(FARE)} PAS fare`);
  take("relay service fee", p.relayServiceFee, "flat, per order");
  take("share of the goods", 0n, "none, ever");
  take("share of the tip or the tax", 0n, "none, ever");

  const value = GOODS + FARE;
  const takeBps = Number((fee * 10_000n) / value);
  console.log(
    `\n  EFFECTIVE SERVICE FEE on a ${pas(value)} PAS delivery: ` +
      `${(takeBps / 100).toFixed(3)}% (${pas(fee)} PAS).`
  );
  console.log(
    `  That is the whole of it. Everything else below is gas paid to the chain,`
  );
  console.log(`  or a payment to another participant.`);

  const chain = customer + driver + venue - TIP;
  console.log(
    `\n  Gas, all three sides, steady state: ${pas(chain)} PAS ` +
      `(${((Number(chain) / Number(value)) * 100).toFixed(1)}% of the delivery's value).`
  );
  console.log(
    `  Plus ${pas(TIP)} PAS to whoever submits the customer's withdrawal, which is`
  );
  console.log(`  a market price and not a fee.`);
  console.log(
    `  At Paseo's testnet gas price, which says nothing about a real chain.`
  );

  console.log("\nTHE EXPENSIVE ONE");
  console.log(
    `  vault.insertShieldNote is ${gas["vault.insertShieldNote"]} gas ` +
      `(${pas(perShield)} PAS), ${
        (gas["vault.insertShieldNote"] / gas["vault.withdraw"]) | 0
      }x a plain`
  );
  console.log(
    `  withdrawal. That is what a private exit costs: it walks a 16-level`
  );
  console.log(
    `  Poseidon tree on-chain. Paid once per bucket, so the per-delivery share`
  );
  console.log(
    `  above assumes shielding at ${pas(bucket)} PAS \u2014 ${driverJobs} fares for a driver.`
  );

  if (p.buckets?.length) {
    console.log(
      `\n  Buckets: ${p.buckets.map((b) => pas(b)).join(", ")} PAS. A balance below the smallest`
    );
    console.log(
      `  cannot be shielded, and waits in the vault until more earnings push it over.`
    );
  }
}

const offline = process.argv.includes("--offline");
if (offline) {
  report({ ...DEFAULTS, buckets: [] });
} else {
  live()
    .then(report)
    .catch((e) => {
      console.log(`(chain unreachable: ${e.message}; using contract defaults)`);
      report({ ...DEFAULTS, buckets: [] });
    });
}
