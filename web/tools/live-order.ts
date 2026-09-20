// Live check of the order lifecycle (npx vite-node tools/live-order.ts).
//
// Registers a venue, places an order from a fresh account, has a "driver"
// commit a sealed bid, and accepts it — the whole auction on the real contracts.
// The bid's terms travel over the Statement Store in the app; here they're
// handed over directly, because publishing a statement needs the host.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Contract, JsonRpcProvider, Wallet, formatEther, keccak256, AbiCoder } from "ethers";
import { CHAIN } from "../src/config";
import DEPLOYED from "../src/deployed.json";
import ORDERS_ABI from "../src/abi/PorterOrders.json";
import VENUES_ABI from "../src/abi/PorterVenues.json";
import DRIVERS_ABI from "../src/abi/PorterDrivers.json";
import { b32, positionCommit, randomSalt } from "../src/order/geo";
import { sealOpening, openSealed } from "../src/order/bids";

const PAS = 10n ** 18n;
const book = DEPLOYED as Record<string, string>;
const eth = new JsonRpcProvider(CHAIN.ethRpc, Number(CHAIN.chainId), { staticNetwork: true });
const funder = new Wallet(readFileSync(join(homedir(), ".config", "porterage", "deploy-key"), "utf8").trim(), eth);

const wait = async (label: string, p: Promise<{ hash: string; wait: () => Promise<unknown> }>) => {
  const tx = await p;
  await tx.wait();
  console.log(`   ${label} ${tx.hash.slice(0, 12)}…`);
};
const fund = async (to: string, amount: bigint) => wait(`funded ${to.slice(0, 8)}…`, funder.sendTransaction({ to, value: amount }));

// Fresh accounts for each role, as the app uses fresh ones.
const venueOp = Wallet.createRandom().connect(eth);
const driver = Wallet.createRandom().connect(eth);
const session = Wallet.createRandom().connect(eth);
const customer = Wallet.createRandom().connect(eth);
console.log(`funder ${funder.address}, ${formatEther(await eth.getBalance(funder.address))} PAS`);
for (const [who, amount] of [[venueOp, 6n * PAS], [driver, 6n * PAS], [session, 4n * PAS], [customer, 12n * PAS]] as const) {
  await fund(who.address, amount);
}

// 1. a venue, signing with a session key
const venues = new Contract(book.venues, VENUES_ABI as never, venueOp);
const VENUE = { lat: 37_774_900, lon: -122_419_400 };
await wait("registered the venue", venues.registerVenue(VENUE.lat, VENUE.lon, session.address, venueOp.address, ""));
const venueId = (await venues.nextVenueId()) - 1n;
console.log(`1. venue #${venueId}`);

// 2. a driver with a session key
const drivers = new Contract(book.drivers, DRIVERS_ABI as never, driver);
await wait("registered the driver", drivers.registerWithSessionKey("", session.address));
console.log(`2. driver ${driver.address} signs with ${session.address}`);

// 3. an order from the customer's fresh account: the drop stays off-chain
const orders = new Contract(book.orders, ORDERS_ABI as never, customer);
const drop = { lat: 37_784_900, lon: -122_419_400 };
const salt = randomSalt();
const goods = PAS;
const maxFare = 2n * PAS;
const orderId = (await orders.nextOrderId()) as bigint;
await wait("created the order", orders.createOrder(venueId, b32(positionCommit(drop, salt)), goods, 0n, maxFare, 0n, 0n, { value: goods }));
console.log(`3. order #${orderId}, status ${await orders.statusOf(orderId)}`);

// 4. a sealed bid: committed by the session key, terms sent to the customer encrypted
const amount = 15n * 10n ** 17n; // 1.5 PAS
const bidSalt = keccak256(crypto.getRandomValues(new Uint8Array(32)));
const sealed = await sealOpening(customer.signingKey.publicKey, { driver: driver.address, amount, salt: bidSalt });
const opening = await openSealed(customer, sealed);
if (!opening || opening.driver.toLowerCase() !== driver.address.toLowerCase() || opening.amount !== amount) {
  throw new Error("the sealed opening didn't survive the round trip");
}
const bidHash = await orders.bidHashOf(orderId, driver.address, amount, bidSalt);
const revokeSecret = keccak256(crypto.getRandomValues(new Uint8Array(32)));
await wait("committed the bid", new Contract(book.orders, ORDERS_ABI as never, session).commitBid(
  orderId, bidHash, keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32"], [revokeSecret])),
));
console.log(`4. bid ${formatEther(amount)} PAS committed as ${bidHash.slice(0, 12)}…, ${sealed.length} B sealed to the customer`);

// 5. the customer accepts, paying the fare
await wait("accepted the bid", orders.acceptSealedBid(orderId, opening.driver, opening.amount, opening.salt, { value: opening.amount }));
const o = await orders.orders(orderId);
console.log(`5. status ${await orders.statusOf(orderId)}, driver ${o.driver}, fare ${formatEther(o.fare)} PAS`);
console.log(`   order account ${customer.address} holds ${formatEther(await eth.getBalance(customer.address))} PAS`);
process.exit(0);
