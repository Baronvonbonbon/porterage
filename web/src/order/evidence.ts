// The photo at the door (docs/PLAN.md §4 step 5).
//
// The driver photographs the delivery, seals it, stores it on Bulletin and
// commits its key on-chain straight away — before any dispute can exist. It
// can't wait for settlement: a disputed order never settles, which is exactly
// when the photo matters.
//
// Only the two of them can open it. The key is the ECDH secret between the
// driver's session key and the order's own account, and neither side has to send
// anything extra: the driver already has the order account's public key from the
// auction, and the customer recovers the driver's from the signature it was just
// handed. Nobody else can read the photo, and the chain holds only its Bulletin
// key.

import {
  Contract,
  SigningKey,
  TypedDataEncoder,
  concat,
  getBytes,
  hexlify,
  keccak256,
  type Wallet,
} from "ethers";
import { ABI, addressOf, ethProvider, read } from "../contracts";
import { hostGet, hostPut } from "../host";
import { PHASE_DROPOFF } from "./handoff";

const DRIVER_COMMIT_TYPES = {
  DriverCommitAttestation: [
    { name: "orderId", type: "uint256" },
    { name: "phase", type: "uint8" },
    { name: "actor", type: "address" },
    { name: "posCommit", type: "bytes32" },
    { name: "timestamp", type: "uint64" },
  ],
};

async function domain() {
  const { chainId } = await ethProvider().getNetwork();
  return { name: "PorterSettlement", version: "1", chainId, verifyingContract: addressOf("settlement") };
}

/**
 * The driver's signing key, recovered from the signature it gave at the door.
 * That signature is the customer's proof of who signed, so it's also the way to
 * the shared secret — no extra message.
 */
export async function driverKeyFromDropSignature(
  att: { orderId: bigint; actor: string; posCommit: string; timestamp: bigint },
  signature: string,
): Promise<string> {
  const digest = TypedDataEncoder.hash(await domain(), DRIVER_COMMIT_TYPES, { ...att, phase: PHASE_DROPOFF });
  return SigningKey.recoverPublicKey(digest, signature);
}

async function sharedKey(mine: SigningKey, theirs: string): Promise<CryptoKey> {
  const shared = getBytes(mine.computeSharedSecret(theirs));
  const material = getBytes(keccak256(shared.slice(1, 33)));
  return crypto.subtle.importKey("raw", material as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Seal a photo so only the other party can open it: nonce, then the sealed bytes. */
export async function sealPhoto(mine: SigningKey, theirs: string, photo: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sharedKey(mine, theirs), photo as BufferSource),
  );
  return getBytes(concat([iv, body]));
}

export async function openPhoto(mine: SigningKey, theirs: string, sealed: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: sealed.slice(0, 12) as BufferSource },
      await sharedKey(mine, theirs),
      sealed.slice(12) as BufferSource,
    ),
  );
}

/**
 * Store the sealed photo and commit its key. The upload is one tap (the host
 * signs the Bulletin write); the commitment is sent by the session key, so no
 * tap, and it must happen before the order settles.
 */
export async function commitPhoto(
  sessionKey: Wallet,
  orderId: bigint,
  customerKey: string,
  photo: Uint8Array,
): Promise<{ key: string; bytes: number }> {
  const sealed = await sealPhoto(sessionKey.signingKey, customerKey, photo);
  const key = await hostPut(sealed);
  const disputes = new Contract(addressOf("disputes"), ABI.disputes.fragments as never, sessionKey);
  await (await disputes.commitEvidence(orderId, key.startsWith("0x") ? key : `0x${key}`)).wait();
  return { key, bytes: sealed.length };
}

/** The key a party committed for this order, or null. */
export async function evidenceKeyOf(orderId: bigint, party: string): Promise<string | null> {
  const e = await read("disputes").evidenceOf(orderId, party);
  const key = e[0] as string;
  return key && key !== `0x${"0".repeat(64)}` ? key : null;
}

/** Fetch and open the driver's photo, as a data URL to show. Null when there isn't one yet. */
export async function fetchPhoto(
  mine: SigningKey,
  driverKey: string,
  orderId: bigint,
  driver: string,
): Promise<string | null> {
  const key = await evidenceKeyOf(orderId, driver);
  if (!key) return null;
  const sealed = await hostGet(key);
  if (!sealed) return null;
  const photo = await openPhoto(mine, driverKey, sealed);
  return `data:image/jpeg;base64,${btoa(String.fromCharCode(...photo))}`;
}

export const photoHex = (b: Uint8Array) => hexlify(b);
