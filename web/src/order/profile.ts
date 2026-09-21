// Who is bidding, and who is coming to the door.
//
// A customer choosing between three bids has a price and a star rating and
// nothing else — which is enough to pick the cheapest and not enough to pick
// the best. A driver with a name, a vehicle and a record is a person who can
// build a reputation worth having; `0x7a3f…c210` is not.
//
// It needs no contract change: `PorterDrivers` already carries a
// `metadataURI` and a `setMetadata`, for exactly this.
//
// THE SPLIT, AND WHY IT IS WHERE IT IS.
//
// The text — a chosen name, the vehicle — is public, on Bulletin, like a
// venue's menu. It has to be: a customer reads it while deciding, before any
// of the bidders has a relationship with them, and there is nobody to seal it
// to yet.
//
// The PHOTO is not public, and this is the one decision in this module worth
// arguing about. A venue's shopfront is a building; a driver's photograph is a
// person's face, tied to an account that never changes, readable by anyone
// who can read the store, for as long as it is there. The people who benefit
// from it being public are not customers — a customer only needs to recognise
// the one driver coming to their own door. So:
//
//   - the photo is encrypted under a random content key and uploaded ONCE.
//     What sits on Bulletin is opaque to everyone, including the people
//     casually browsing bids.
//   - the content key travels per order, sealed to the customer that WON the
//     driver the job, on the pair thread the two already share.
//   - so the face is known to the person at the door, and to nobody else.
//
// The cost of doing it this way is one Bulletin write, ever, rather than one
// per order — which matters, because a write was measured at a host prompt and
// 6 to 31 seconds (probe.ts, 2026-09-21). Sealing the whole photo per customer
// would put that on every single delivery.

import { getBytes, hexlify, keccak256, toUtf8Bytes } from "ethers";
import { ABI, addressOf, read } from "../contracts";
import { hostCall } from "../hostchain";
import { hostGet, hostPut } from "../host";
import { publishStatement, subscribeTopics } from "../market/statements";
import { open, seal, type Reader } from "./seal";
import { sideChannel, threadTopic } from "./chat";

const PREFIX = "bulletin:";

/** A sealed envelope carrying one 32-byte content key (seal.ts kinds). */
const FACE = 14;
const VERSION = 1;

/** Long enough to outlive any order. A statement always carries an expiry. */
const KEEP_S = 12 * 3600;

export const MAX_NAME = 24;
export const MAX_VEHICLE = 32;

export interface Profile {
  /** What to call them. Chosen, not verified, and not an identity document. */
  name: string;
  /** What will pull up outside: "blue Honda scooter". */
  vehicle?: string;
  /** Bulletin key of the ENCRYPTED photo. Useless without the content key. */
  face?: string;
}

// ── the public half ─────────────────────────────────────────────────────────

/** Trim to what a bid row can show. A name is a label, not an essay. */
const tidy = (text: string, max: number) =>
  text.replace(/\s+/g, " ").trim().slice(0, max);

export function encodeProfile(p: Profile): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      v: VERSION,
      n: tidy(p.name, MAX_NAME),
      ...(p.vehicle?.trim() ? { c: tidy(p.vehicle, MAX_VEHICLE) } : {}),
      ...(p.face ? { f: p.face } : {}),
    })
  );
}

/**
 * Read a profile someone else wrote. Everything is clamped on the way in: this
 * is a public document any registered driver can publish, and it is about to
 * be drawn next to a price someone is deciding on.
 */
export function decodeProfile(bytes: Uint8Array): Profile | null {
  try {
    const doc = JSON.parse(new TextDecoder().decode(bytes)) as {
      v?: number;
      n?: string;
      c?: string;
      f?: string;
    };
    if (doc.v !== VERSION || typeof doc.n !== "string") return null;
    const name = tidy(doc.n, MAX_NAME);
    if (!name) return null;
    return {
      name,
      ...(typeof doc.c === "string" && doc.c.trim()
        ? { vehicle: tidy(doc.c, MAX_VEHICLE) }
        : {}),
      ...(typeof doc.f === "string" && /^(0x)?[0-9a-f]{64}$/i.test(doc.f)
        ? { face: doc.f }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Publish the public half and point the driver record at it. One tap each. */
export async function publishProfile(p: Profile): Promise<string> {
  const key = await hostPut(encodeProfile(p));
  const uri = PREFIX + (key.startsWith("0x") ? key.slice(2) : key);
  await hostCall(
    addressOf("drivers"),
    ABI.drivers.encodeFunctionData("setMetadata", [uri])
  );
  return uri;
}

/**
 * Cached by URI across the life of the page. A Bulletin URI is the hash of its
 * content, so a cached profile can never be stale — a driver who changes their
 * name publishes a different URI and the record points somewhere else.
 */
const seen = new Map<string, Promise<Profile | null>>();

export function profileOf(address: string): Promise<Profile | null> {
  const found = seen.get(address.toLowerCase());
  if (found) return found;
  const reading = (async () => {
    try {
      const record = await read("drivers").drivers(address);
      const uri: string = record.metadataURI ?? "";
      if (!uri.startsWith(PREFIX)) return null;
      const bytes = await hostGet(uri.slice(PREFIX.length));
      return bytes ? decodeProfile(bytes) : null;
    } catch {
      return null;
    }
  })();
  seen.set(address.toLowerCase(), reading);
  return reading;
}

export function _forgetProfiles(): void {
  seen.clear();
}

// ── the face ────────────────────────────────────────────────────────────────

/**
 * Encrypt a photo under a fresh content key and put it on Bulletin. The key
 * comes back for the driver to keep; the bytes on Bulletin mean nothing
 * without it.
 */
export async function sealFace(
  photo: Uint8Array
): Promise<{ bulletin: string; contentKey: Uint8Array }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"]
  );
  const body = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      photo as BufferSource
    )
  );
  const blob = new Uint8Array(12 + body.length);
  blob.set(iv, 0);
  blob.set(body, 12);
  return { bulletin: await hostPut(blob), contentKey: raw };
}

/** Open a face with the content key its driver sent. */
export async function openFace(
  contentKey: Uint8Array,
  blob: Uint8Array
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    contentKey as BufferSource,
    "AES-GCM",
    false,
    ["decrypt"]
  );
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: blob.slice(0, 12) as BufferSource },
      key,
      blob.slice(12) as BufferSource
    )
  );
}

/** One slot per customer, so sending it again replaces rather than piles up. */
const faceChannel = (topic: string, mine: Reader): string =>
  keccak256(
    concatBytes(
      toUtf8Bytes("porterage:face"),
      getBytes(sideChannel(topic, mine.signingKey))
    )
  );

const concatBytes = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/**
 * Give the customer that picked you the key to your face. 32 bytes, sealed, on
 * the thread the two of you already share — so it costs one statement and no
 * tap, however many orders a driver takes.
 */
export async function sendFace(
  mine: Reader,
  customerKey: string,
  contentKey: Uint8Array
): Promise<void> {
  const topic = threadTopic(mine.signingKey, customerKey);
  await publishStatement(
    topic,
    faceChannel(topic, mine),
    await seal(customerKey, FACE, contentKey),
    KEEP_S
  );
}

/** Watch for the key to the driver's face. */
export function watchFace(
  mine: Reader,
  driverKey: string,
  heard: (contentKey: Uint8Array) => void
): Promise<() => void> {
  const topic = threadTopic(mine.signingKey, driverKey);
  return subscribeTopics([topic], async (bytes) => {
    const plain = await open(mine, FACE, bytes);
    if (plain?.length === 32) heard(plain);
  });
}

/** Fetch and open a driver's face, given the key they sent. */
export async function faceUrl(
  bulletinKey: string,
  contentKey: Uint8Array
): Promise<string | null> {
  try {
    const blob = await hostGet(bulletinKey);
    if (!blob?.length) return null;
    const photo = await openFace(contentKey, blob);
    return URL.createObjectURL(new Blob([photo], { type: "image/jpeg" }));
  } catch {
    return null;
  }
}

/** For the driver's own screen, which keeps its content key locally. */
export const keyHex = (k: Uint8Array): string => hexlify(k);
export const keyBytes = (hex: string): Uint8Array => getBytes(hex);
