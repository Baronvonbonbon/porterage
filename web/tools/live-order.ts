// Live check of the order lifecycle (npx vite-node tools/live-order.ts).
//
// Registers a venue, places an order from a fresh account, has a "driver"
// commit a sealed bid, and accepts it — the whole auction on the real contracts.
// The bid's terms travel over the Statement Store in the app; here they're
// handed over directly, because publishing a statement needs the host.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Contract, JsonRpcProvider, SigningKey, Wallet, formatEther, keccak256, AbiCoder } from "ethers";
import { CHAIN } from "../src/config";
import DEPLOYED from "../src/deployed.json";
import ORDERS_ABI from "../src/abi/PorterOrders.json";
import VENUES_ABI from "../src/abi/PorterVenues.json";
import DRIVERS_ABI from "../src/abi/PorterDrivers.json";
import { b32, dropNullifier, encLat, encLon, positionCommit, randomSalt } from "../src/order/geo";
import { decodePayload, encodeDropRequest, encodeDropSignature, encodePickup, makeDropRequest } from "../src/order/handoff";
import { driverKeyFromDropSignature, openPhoto, sealPhoto } from "../src/order/evidence";
import DISPUTES_ABI from "../src/abi/PorterDisputes.json";
import SETTLEMENT_ABI from "../src/abi/PorterSettlement.json";
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

// 6. pickup: the counter signs its own registered pin; the driver signs the same
const settlement = new Contract(book.settlement, SETTLEMENT_ABI as never, session);
const { chainId } = await eth.getNetwork();
const domain = { name: "PorterSettlement", version: "1", chainId, verifyingContract: book.settlement };
const LOCATION_TYPES = { LocationAttestation: [
  { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" }, { name: "actor", type: "address" },
  { name: "lat", type: "int32" }, { name: "lon", type: "int32" }, { name: "timestamp", type: "uint64" },
] };
const DRIVER_COMMIT_TYPES = { DriverCommitAttestation: [
  { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" }, { name: "actor", type: "address" },
  { name: "posCommit", type: "bytes32" }, { name: "timestamp", type: "uint64" },
] };
const now = BigInt(Math.floor(Date.now() / 1000));
const vAtt = { orderId, phase: 1, actor: session.address, lat: VENUE.lat, lon: VENUE.lon, timestamp: now };
const dAtt = { orderId, phase: 1, actor: driver.address, lat: VENUE.lat, lon: VENUE.lon, timestamp: now };
const vSig = await session.signTypedData(domain, LOCATION_TYPES, vAtt);
const dSig = await session.signTypedData(domain, LOCATION_TYPES, dAtt);
// The QR carries exactly this, at 90 bytes.
const pickupCode = encodePickup({ orderId, at: VENUE, timestamp: now, signature: vSig });
const readBack = decodePayload(pickupCode);
if (readBack.kind !== "pickup" || readBack.signature !== vSig) throw new Error("the pickup code didn't survive its QR");
console.log(`6. pickup code ${pickupCode.length} chars of text`);
await wait("confirmed the pickup", settlement.confirmPickup(dAtt, dSig, vAtt, vSig));
console.log(`   status ${await orders.statusOf(orderId)} (venue paid)`);

// 7. dropoff: the customer commits to its own drop, the driver signs it blind
const request = makeDropRequest(orderId, drop);
const reqCode = encodeDropRequest(request.payload);
const signedAt = BigInt(Math.floor(Date.now() / 1000));
const drvAtt = { orderId, phase: 2, actor: driver.address, posCommit: request.payload.posCommit, timestamp: signedAt };
const drvSig = await session.signTypedData(domain, DRIVER_COMMIT_TYPES, drvAtt);
const backCode = encodeDropSignature({ orderId, timestamp: signedAt, signature: drvSig });
console.log(`7. door code ${reqCode.length} chars, driver's reply ${backCode.length} chars`);

// 7b. the photo: sealed to the customer, its key committed before settlement
const photo = new Uint8Array(2048).fill(7); // stands in for a JPEG
const sealedPhoto = await sealPhoto(session.signingKey, customer.signingKey.publicKey, photo);
// The customer never receives the driver's key: it recovers it from the signature it was handed.
const recovered = await driverKeyFromDropSignature(
  { orderId, actor: driver.address, posCommit: request.payload.posCommit, timestamp: signedAt }, drvSig,
);
if (SigningKey.computePublicKey(recovered, false) !== SigningKey.computePublicKey(session.signingKey.publicKey, false)) {
  throw new Error("the driver's key didn't come back out of the signature");
}
const opened = await openPhoto(customer.signingKey, recovered, sealedPhoto);
if (opened.length !== photo.length || opened[0] !== photo[0]) throw new Error("the customer couldn't open the photo");
// On a phone the sealed bytes go to Bulletin and this is their key; here, their hash stands in.
const evidenceKey = keccak256(sealedPhoto);
await wait("committed the photo's key", new Contract(book.disputes, DISPUTES_ABI as never, session)
  .commitEvidence(orderId, evidenceKey));
const onChain = await new Contract(book.disputes, DISPUTES_ABI as never, eth).evidenceOf(orderId, driver.address);
console.log(`7b. photo sealed to ${sealedPhoto.length} B, key ${String(onChain[0]).slice(0, 12)}… committed at ${onChain[1]}`);
if (String(onChain[0]).toLowerCase() !== evidenceKey.toLowerCase()) throw new Error("the committed key doesn't match");

// 8. the customer proves and settles, from the order's own account
const settlementRead = new Contract(book.settlement, SETTLEMENT_ABI as never, eth);
const radius = Number(await settlementRead.dropoffRadiusMeters());
const shield = (f: string) => join(import.meta.dirname, "..", "public", "zk", f);
const snarkjs = await import("snarkjs");
const t0 = Date.now();
const { proof, publicSignals } = await snarkjs.groth16.fullProve(
  {
    orderId: orderId.toString(),
    dropCommit: positionCommit(drop, salt).toString(),
    driverCommit: BigInt(request.payload.posCommit).toString(),
    radiusMeters: String(radius),
    nullifier: dropNullifier(salt, orderId).toString(),
    custLatEnc: encLat(drop.lat).toString(), custLonEnc: encLon(drop.lon).toString(), salt: salt.toString(),
    drvLatEnc: encLat(drop.lat).toString(), drvLonEnc: encLon(drop.lon).toString(), drvSalt: request.driverSalt.toString(),
  },
  shield("proximity.wasm"), shield("proximity.zkey"),
);
console.log(`8. proved proximity in ${Date.now() - t0} ms`);
const packed = AbiCoder.defaultAbiCoder().encode(Array(8).fill("uint256"), [
  proof.pi_a[0], proof.pi_a[1], proof.pi_b[0][1], proof.pi_b[0][0],
  proof.pi_b[1][1], proof.pi_b[1][0], proof.pi_c[0], proof.pi_c[1],
]);
await wait("settled the delivery", new Contract(book.settlement, SETTLEMENT_ABI as never, customer)
  .confirmDropoffZK(drvAtt, drvSig, packed, publicSignals));
console.log(`   status ${await orders.statusOf(orderId)} (driver paid)`);

// 9. nothing about the drop reached the chain
const vault = new Contract(book.vault, ["function balanceOf(address) view returns (uint256)"], eth);
console.log(`9. vault: venue ${formatEther(await vault.balanceOf(venueOp.address))} PAS, driver ${formatEther(await vault.balanceOf(driver.address))} PAS`);
const calldata = packed + publicSignals.join("");
for (const secret of [encLat(drop.lat).toString(16), encLon(drop.lon).toString(16), salt.toString(16)]) {
  if (calldata.toLowerCase().includes(secret.toLowerCase())) throw new Error("the drop leaked into the settlement");
}
console.log("   the drop, its salt and the coordinates appear nowhere in what was sent");
process.exit(0);
