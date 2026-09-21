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
  return {
    name: "PorterSettlement",
    version: "1",
    chainId,
    verifyingContract: addressOf("settlement"),
  };
}

/**
 * The driver's signing key, recovered from the signature it gave at the door.
 * That signature is the customer's proof of who signed, so it's also the way to
 * the shared secret — no extra message.
 */
export async function driverKeyFromDropSignature(
  att: { orderId: bigint; actor: string; posCommit: string; timestamp: bigint },
  signature: string
): Promise<string> {
  const digest = TypedDataEncoder.hash(await domain(), DRIVER_COMMIT_TYPES, {
    ...att,
    phase: PHASE_DROPOFF,
  });
  return SigningKey.recoverPublicKey(digest, signature);
}

async function sharedKey(mine: SigningKey, theirs: string): Promise<CryptoKey> {
  const shared = getBytes(mine.computeSharedSecret(theirs));
  const material = getBytes(keccak256(shared.slice(1, 33)));
  return crypto.subtle.importKey(
    "raw",
    material as BufferSource,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"]
  );
}

// The photo is encrypted under a CONTENT KEY of its own, and that key is what
// gets wrapped to the other party. It costs one extra step and buys the thing a
// dispute needs: the key can be handed to an arbiter (order/dispute.ts) without
// handing over the identity key that wrapped it, which would open every other
// photo, message and bid that key has ever touched.
//
//   0..12    the nonce the content key was wrapped under
//   12..60   the wrapped content key (32 bytes and its tag)
//   60..72   the nonce the photo was encrypted under
//   72..     the photo
const WRAPPED = 60;
const BODY = 72;

const contentKey = (raw: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);

/**
 * ONE EVIDENCE KEY, TWO PHOTOS, and the reason is in the contract:
 * `PorterDisputes.commitEvidence` refuses a second commitment from the same
 * party ("already-committed"), so a driver gets exactly one key per order. A
 * photo at the counter and a photo at the door would need two, and the second
 * would revert — the delivery photo, the one that actually matters, lost to a
 * pickup photo taken twenty minutes earlier.
 *
 * So both travel inside the one sealed blob. The arbiter's flow does not
 * change at all: it is still handed a single content key, and what opens is
 * now an album rather than a picture.
 *
 * A plaintext that does not start with the marker is a single photo, which is
 * how everything committed before today still reads.
 */
const ALBUM = [0x50, 0x41, 0x31]; // "PA1"

export function packAlbum(photos: Uint8Array[]): Uint8Array {
  if (photos.length === 1) return photos[0];
  const size = 4 + photos.reduce((n, p) => n + 4 + p.length, 0);
  const out = new Uint8Array(size);
  out.set(ALBUM, 0);
  out[3] = photos.length;
  let at = 4;
  for (const photo of photos) {
    new DataView(out.buffer).setUint32(at, photo.length);
    out.set(photo, at + 4);
    at += 4 + photo.length;
  }
  return out;
}

export function unpackAlbum(plain: Uint8Array): Uint8Array[] {
  if (plain.length < 4 || !ALBUM.every((b, i) => plain[i] === b))
    return [plain];
  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  const photos: Uint8Array[] = [];
  let at = 4;
  for (let n = 0; n < plain[3]; n++) {
    if (at + 4 > plain.length) break;
    const size = view.getUint32(at);
    // A length longer than what is left means a truncated or tampered blob.
    // Stop rather than throw: one readable photo is better than none.
    if (at + 4 + size > plain.length) break;
    photos.push(plain.slice(at + 4, at + 4 + size));
    at += 4 + size;
  }
  return photos.length ? photos : [plain];
}

/** Seal a photo so only the other party can open it, under a key of its own. */
export async function sealPhoto(
  mine: SigningKey,
  theirs: string,
  photo: Uint8Array
): Promise<Uint8Array> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: wrapIv },
      await sharedKey(mine, theirs),
      raw as BufferSource
    )
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await contentKey(raw),
      photo as BufferSource
    )
  );
  return getBytes(concat([wrapIv, wrapped, iv, body]));
}

/** The photo's own key, which either party can unwrap — and only they. */
export async function photoKeyOf(
  mine: SigningKey,
  theirs: string,
  sealed: Uint8Array
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: sealed.slice(0, 12) as BufferSource },
      await sharedKey(mine, theirs),
      sealed.slice(12, WRAPPED) as BufferSource
    )
  );
}

/** Open a photo with its content key alone — what an arbiter is given. */
export async function openWithKey(
  raw: Uint8Array,
  sealed: Uint8Array
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: sealed.slice(WRAPPED, BODY) as BufferSource },
      await contentKey(raw),
      sealed.slice(BODY) as BufferSource
    )
  );
}

export async function openPhoto(
  mine: SigningKey,
  theirs: string,
  sealed: Uint8Array
): Promise<Uint8Array> {
  return openWithKey(await photoKeyOf(mine, theirs, sealed), sealed);
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
  photo: Uint8Array | Uint8Array[]
): Promise<{ key: string; bytes: number }> {
  const sealed = await sealPhoto(
    sessionKey.signingKey,
    customerKey,
    packAlbum(Array.isArray(photo) ? photo : [photo])
  );
  const key = await hostPut(sealed);
  const disputes = new Contract(
    addressOf("disputes"),
    ABI.disputes.fragments as never,
    sessionKey
  );
  await (
    await disputes.commitEvidence(
      orderId,
      key.startsWith("0x") ? key : `0x${key}`
    )
  ).wait();
  return { key, bytes: sealed.length };
}

/** The key a party committed for this order, or null. */
export async function evidenceKeyOf(
  orderId: bigint,
  party: string
): Promise<string | null> {
  const e = await read("disputes").evidenceOf(orderId, party);
  const key = e[0] as string;
  return key && key !== `0x${"0".repeat(64)}` ? key : null;
}

/** Fetch and open the driver's photo, as a data URL to show. Null when there isn't one yet. */
export async function fetchPhoto(
  mine: SigningKey,
  driverKey: string,
  orderId: bigint,
  driver: string
): Promise<string | null> {
  const key = await evidenceKeyOf(orderId, driver);
  if (!key) return null;
  const sealed = await hostGet(key);
  if (!sealed) return null;
  const photo = await openPhoto(mine, driverKey, sealed);
  return asDataUrl(unpackAlbum(photo)[0]);
}

/** Everything the driver committed for this order, oldest first. */
export async function fetchPhotos(
  mine: SigningKey,
  driverKey: string,
  orderId: bigint,
  driver: string
): Promise<string[]> {
  const key = await evidenceKeyOf(orderId, driver);
  if (!key) return [];
  const sealed = await hostGet(key);
  if (!sealed) return [];
  return unpackAlbum(await openPhoto(mine, driverKey, sealed)).map(asDataUrl);
}

/** JPEG bytes as something an <img> can show. */
export const asDataUrl = (photo: Uint8Array): string =>
  `data:image/jpeg;base64,${btoa(String.fromCharCode(...photo))}`;

/**
 * The content key of a photo already on Bulletin, for enclosing in a dispute.
 * Null when that party committed nothing, or the bytes have aged out.
 */
export async function committedPhotoKey(
  mine: SigningKey,
  theirs: string,
  orderId: bigint,
  party: string
): Promise<Uint8Array | null> {
  const key = await evidenceKeyOf(orderId, party);
  if (!key) return null;
  const sealed = await hostGet(key);
  if (!sealed) return null;
  return photoKeyOf(mine, theirs, sealed);
}

export const photoHex = (b: Uint8Array) => hexlify(b);
