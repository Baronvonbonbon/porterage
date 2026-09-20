// Live check of the dispute path (npx vite-node tools/live-dispute.ts).
//
// The happy path is live-order.ts. This is the other one: an order that is
// picked up and then goes wrong. It checks the part that can't be checked
// anywhere else — that the arbiter can be handed the key to the driver's photo,
// read that photo, and rule, without ever being given a key that opens anything
// else.
//
// The arbiter here is the deploy key, which is what the testnet deploy sets and
// the plainest centralisation left in the design.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  computeAddress,
  formatEther,
  keccak256,
} from "ethers";
import { CHAIN } from "../src/config";
import DEPLOYED from "../src/deployed.json";
import ORDERS_ABI from "../src/abi/PorterOrders.json";
import VENUES_ABI from "../src/abi/PorterVenues.json";
import DRIVERS_ABI from "../src/abi/PorterDrivers.json";
import DISPUTES_ABI from "../src/abi/PorterDisputes.json";
import VAULT_ABI from "../src/abi/PorterVault.json";
import { b32, positionCommit, randomSalt } from "../src/order/geo";
import { openWithKey, photoKeyOf, sealPhoto } from "../src/order/evidence";
import { decodeCase, encodeCase } from "../src/order/dispute";
import { open as openEnvelope, seal } from "../src/order/seal";

const PAS = 10n ** 18n;
const book = DEPLOYED as Record<string, string>;
const eth = new JsonRpcProvider(CHAIN.ethRpc, Number(CHAIN.chainId), {
  staticNetwork: true,
});
const funder = new Wallet(
  readFileSync(
    join(homedir(), ".config", "porterage", "deploy-key"),
    "utf8"
  ).trim(),
  eth
);

const wait = async (
  label: string,
  p: Promise<{ hash: string; wait: () => Promise<unknown> }>
) => {
  const tx = await p;
  await tx.wait();
  console.log(`   ${label} ${tx.hash.slice(0, 12)}…`);
};
const fund = (to: string, amount: bigint) =>
  wait(
    `funded ${to.slice(0, 8)}…`,
    funder.sendTransaction({ to, value: amount })
  );

const venueOp = Wallet.createRandom().connect(eth);
const driver = Wallet.createRandom().connect(eth);
const session = Wallet.createRandom().connect(eth);
const customer = Wallet.createRandom().connect(eth);
console.log(
  `funder ${funder.address}, ${formatEther(
    await eth.getBalance(funder.address)
  )} PAS`
);
for (const [who, amount] of [
  [venueOp, 3n * PAS],
  [driver, 3n * PAS],
  [session, 2n * PAS],
  [customer, 7n * PAS],
] as const) {
  await fund(who.address, amount);
}

/**
 * Give back what the throwaway accounts didn't spend. Registered for failures
 * too: a run that dies halfway used to strand everything it was funded with,
 * which is most of what a run costs.
 */
async function giveBack() {
  for (const who of [venueOp, driver, session, customer]) {
    try {
      const balance = await eth.getBalance(who.address);
      const keep = 2n * 10n ** 17n; // enough for the gas of the refund itself
      if (balance > keep)
        await (
          await who.sendTransaction({
            to: funder.address,
            value: balance - keep,
          })
        ).wait();
    } catch {
      /* not worth failing over */
    }
  }
  console.log(
    `   funder back to ${formatEther(await eth.getBalance(funder.address))} PAS`
  );
}

for (const bad of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(bad, async (e) => {
    console.error(e);
    await giveBack();
    process.exit(1);
  });
}

// 0. the arbiter the app would seal to, checked the way the app checks it
const disputesRead = new Contract(book.disputes, DISPUTES_ABI as never, eth);
const arbiterAddress: string = await disputesRead.arbiter();
if (computeAddress(book.arbiterKey) !== arbiterAddress)
  throw new Error("the published arbiter key isn't the arbiter");
const arbiter = funder; // on the testnet, the deploy key
console.log(
  `0. arbiter ${arbiterAddress}, bond ${formatEther(
    await disputesRead.disputeBond()
  )} PAS`
);

// 1–3. a venue, a driver, an order, a bid taken
const venues = new Contract(book.venues, VENUES_ABI as never, venueOp);
const VENUE = { lat: 37_774_900, lon: -122_419_400 };
await wait(
  "registered the venue",
  venues.registerVenue(
    VENUE.lat,
    VENUE.lon,
    session.address,
    venueOp.address,
    ""
  )
);
const venueId = (await venues.nextVenueId()) - 1n;
await wait(
  "registered the driver",
  new Contract(
    book.drivers,
    DRIVERS_ABI as never,
    driver
  ).registerWithSessionKey("", session.address)
);

const orders = new Contract(book.orders, ORDERS_ABI as never, customer);
const drop = { lat: 37_784_900, lon: -122_419_400 };
const salt = randomSalt();
const goods = PAS;
const orderId = (await orders.nextOrderId()) as bigint;
await wait(
  "created the order",
  orders.createOrder(
    venueId,
    b32(positionCommit(drop, salt)),
    goods,
    0n,
    2n * PAS,
    0n,
    0n,
    { value: goods }
  )
);
const amount = 15n * 10n ** 17n;
const bidSalt = keccak256(crypto.getRandomValues(new Uint8Array(32)));
const bidHash = await orders.bidHashOf(
  orderId,
  driver.address,
  amount,
  bidSalt
);
await wait(
  "committed the bid",
  new Contract(book.orders, ORDERS_ABI as never, session).commitBid(
    orderId,
    bidHash,
    keccak256(crypto.getRandomValues(new Uint8Array(32)))
  )
);
await wait(
  "accepted the bid",
  orders.acceptSealedBid(orderId, driver.address, amount, bidSalt, {
    value: amount,
  })
);
console.log(
  `1. order #${orderId} assigned to ${driver.address.slice(
    0,
    10
  )}…, status ${await orders.statusOf(orderId)}`
);

// 4. the driver's photo, sealed to the customer under a key of its own
const photo = crypto.getRandomValues(new Uint8Array(2048));
const sealedPhoto = await sealPhoto(
  session.signingKey,
  customer.signingKey.compressedPublicKey,
  photo
);
const evidenceKey = keccak256(sealedPhoto); // on a phone this is the Bulletin key
await wait(
  "committed the photo's key",
  new Contract(book.disputes, DISPUTES_ABI as never, session).commitEvidence(
    orderId,
    evidenceKey
  )
);
const committed = await disputesRead.evidenceOf(orderId, driver.address);
console.log(
  `2. photo ${sealedPhoto.length} B, key ${String(committed[0]).slice(
    0,
    12
  )}… committed at ${committed[1]}`
);

// 5. the customer files, enclosing the photo's content key and nothing else
const photoKey = await photoKeyOf(
  customer.signingKey,
  session.signingKey.compressedPublicKey,
  sealedPhoto
);
const papers = await seal(
  book.arbiterKey,
  8,
  encodeCase({ reason: "Left at the wrong door.", photoKey })
);
const uri = "porterage:case:1:" + Buffer.from(papers).toString("hex");
const disputes = new Contract(book.disputes, DISPUTES_ABI as never, customer);
await wait(
  "filed the dispute",
  disputes.openDispute(orderId, uri, {
    value: await disputesRead.disputeBond(),
  })
);
const disputeId = await disputesRead.disputeOfOrder(orderId);
console.log(
  `3. dispute #${disputeId}, order status ${await orders.statusOf(
    orderId
  )} (6 = disputed), papers ${uri.length} chars`
);

// 6. only the arbiter can read the papers, and the key opens only this photo
if (await openEnvelope({ signingKey: session.signingKey }, 8, papers))
  throw new Error("the driver could read the case");
const read = decodeCase(
  (await openEnvelope({ signingKey: arbiter.signingKey }, 8, papers))!
)!;
if (read.reason !== "Left at the wrong door.")
  throw new Error("the arbiter misread the case");
const fetched =
  keccak256(sealedPhoto) === String(committed[0]) ? sealedPhoto : null;
if (!fetched) throw new Error("the bytes don't match what was committed");
const opened = await openWithKey(read.photoKey!, fetched);
if (opened.length !== photo.length || opened[0] !== photo[0])
  throw new Error("the arbiter couldn't open the photo");
const other = await sealPhoto(
  session.signingKey,
  customer.signingKey.compressedPublicKey,
  photo
);
let leaked = true;
try {
  await openWithKey(read.photoKey!, other);
} catch {
  leaked = false;
}
if (leaked) throw new Error("that key opened a second photo");
console.log(
  "4. the arbiter read the case and the photo; the same key opens no other photo"
);

// 7. the ruling: the customer gets three quarters back, the driver the rest.
// With --leave-open the dispute is left standing, so the arbiter's own console
// (tools/ops.ts) can be the thing that rules on it.
if (process.argv.includes("--leave-open")) {
  console.log(
    `5. left dispute #${disputeId} open — rule on it with: npx vite-node tools/ops.ts -- rule ${disputeId} 5000`
  );
  process.exit(0);
}

const vault = new Contract(book.vault, VAULT_ABI as never, eth);
const before = {
  customer: await vault.balanceOf(customer.address),
  driver: await vault.balanceOf(driver.address),
};
await wait(
  "ruled",
  new Contract(book.disputes, DISPUTES_ABI as never, arbiter).resolve(
    disputeId,
    7500,
    true,
    true,
    0
  )
);
const after = {
  customer: await vault.balanceOf(customer.address),
  driver: await vault.balanceOf(driver.address),
};
console.log(
  `5. status ${await orders.statusOf(orderId)}, customer +${formatEther(
    after.customer - before.customer
  )} PAS, driver +${formatEther(after.driver - before.driver)} PAS`
);
if (after.customer <= before.customer)
  throw new Error("the customer was refunded nothing");
const record = await new Contract(
  book.drivers,
  DRIVERS_ABI as never,
  eth
).drivers(driver.address);
console.log(
  `   driver's record: ${record.delivered} delivered, ${record.failed} failed`
);
if (record.failed !== 1n)
  throw new Error("the at-fault ruling left no mark on the driver");

await giveBack();

process.exit(0);
