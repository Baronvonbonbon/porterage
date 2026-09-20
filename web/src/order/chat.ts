// Order messages, with no server and no room anyone can find (docs/PLAN.md §6).
//
// A thread is a PAIR — customer↔driver, customer↔venue, driver↔venue — and its
// topic is derived from the ECDH secret between the two parties' keys. Unlike
// the order topic, which anyone can compute from an order id, a thread can't
// even be found without holding one of the two private keys. What's sent on it
// is sealed as well, on the same footing as bids and baskets.
//
// Each side keeps ONE statement, replaced in place (§6.2): a rolling window of
// its own recent messages. So a thread costs two statements however long it
// runs, which is what the store's budget allows; the price is that the oldest
// messages age out of a long conversation.
//
// Nothing carries a sender field, and nothing needs to. An envelope is sealed
// with a throwaway key, so the statements this device can open are exactly the
// ones it didn't send. Its own side comes from local storage, which is also
// what lets it republish the window.

import {
  SigningKey,
  concat,
  getBytes,
  hexlify,
  keccak256,
  toUtf8Bytes,
  toUtf8String,
} from "ethers";
import { publishStatement, subscribeTopics } from "../market/statements";
import {
  rememberArchive,
  rememberSaid,
  threadOf,
  threadRecord,
} from "../shield/notes";
import { hostGet, hostPut } from "../host";
import { open, seal, type Reader } from "./seal";

const INTRO = 6;
const CHAT = 7;
/** A whole transcript on Bulletin, for a conversation that outgrew a statement. */
const ARCHIVE = 12;

/** What a statement's data may hold, less the envelope's header and its tag. */
const MAX_PAYLOAD = 448;
/** The order id and a flags byte, then 5 bytes of header per message. */
const HEAD = 9;
/** Bit 0 of the flags: a Bulletin key follows, holding the whole transcript. */
const HAS_ARCHIVE = 1;
const KEY_BYTES = 32;
const PER_MESSAGE = 5;
/** A message's length is one byte on the wire, and text is counted in bytes. */
export const MAX_TEXT_BYTES = 255;
/** What the box lets someone type: enough that even all-accented text fits. */
export const MAX_TEXT = 120;

/**
 * The text as at most 255 UTF-8 bytes, never splitting a character. Counting
 * characters would not do: one emoji is four bytes, and a length byte can't
 * hold what 200 of them weigh.
 */
export function clip(text: string): Uint8Array {
  let body = toUtf8Bytes(text);
  let chars = [...text];
  while (body.length > MAX_TEXT_BYTES) {
    chars = chars.slice(0, -1);
    body = toUtf8Bytes(chars.join(""));
  }
  return body;
}

/** Eight bytes, big-endian: how an order id is written everywhere here. */
function u64(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

const readU64 = (b: Uint8Array): bigint =>
  b.slice(0, 8).reduce((v, byte) => (v << 8n) | BigInt(byte), 0n);

export type Role = "customer" | "driver" | "venue";
const ROLES: Role[] = ["customer", "driver", "venue"];

export interface Message {
  at: number;
  text: string;
  /** This device sent it. */
  mine: boolean;
}

// ── who talks to whom ────────────────────────────────────────────────────────

/**
 * The topic for the thread between these two. Both sides compute the same one
 * from their own private key and the other's public key, and nobody else can
 * compute it at all.
 */
export function threadTopic(mine: SigningKey, theirs: string): string {
  const shared = getBytes(mine.computeSharedSecret(theirs));
  return keccak256(
    concat([toUtf8Bytes("porterage:thread:v1"), shared.slice(1, 33)])
  );
}

/** This party's own slot on the thread, so each side replaces only its own statement. */
export const sideChannel = (topic: string, mine: SigningKey): string =>
  keccak256(
    concat([topic, getBytes(SigningKey.computePublicKey(mine.publicKey, true))])
  );

// ── introductions ────────────────────────────────────────────────────────────

/**
 * Before a thread exists, one side has to hand over its key. It does that on a
 * topic both already share — the order's, or the venue's — sealed to the key it
 * already holds, so the introduction is no more public than the thread.
 */
export function encodeIntro(
  orderId: bigint,
  publicKey: string,
  role: Role
): Uint8Array {
  const key = getBytes(SigningKey.computePublicKey(publicKey, true));
  const out = new Uint8Array(9 + 33);
  out.set(u64(orderId), 0);
  out[8] = ROLES.indexOf(role);
  out.set(key, 9);
  return out;
}

export interface Intro {
  orderId: bigint;
  publicKey: string;
  role: Role;
}

export function decodeIntro(bytes: Uint8Array): Intro | null {
  if (bytes.length !== 42 || bytes[8] >= ROLES.length) return null;
  return {
    orderId: readU64(bytes),
    role: ROLES[bytes[8]],
    publicKey: hexlify(bytes.slice(9)),
  };
}

/** Send an introduction on a topic the two already share. */
export async function introduce(
  mine: Reader,
  theirs: string,
  topic: string,
  orderId: bigint,
  role: Role
): Promise<void> {
  const key = SigningKey.computePublicKey(mine.signingKey.publicKey, true);
  // One slot per party per order, so a second introduction replaces the first
  // instead of filling the account (§6.2).
  const channel = keccak256(
    concat([toUtf8Bytes("porterage:intro"), getBytes(key), u64(orderId)])
  );
  await publishStatement(
    topic,
    channel,
    await seal(theirs, INTRO, encodeIntro(orderId, key, role))
  );
}

/** Watch a shared topic for introductions addressed to this device. */
export function watchIntros(
  mine: Reader,
  topic: string,
  heard: (intro: Intro) => void
): Promise<() => void> {
  return subscribeTopics([topic], async (bytes) => {
    const plain = await open(mine, INTRO, bytes);
    const intro = plain && decodeIntro(plain);
    if (intro) heard(intro);
  });
}

// ── the messages themselves ──────────────────────────────────────────────────

/**
 * One side's window: the order it belongs to, then each message as its time,
 * its length and its text. The oldest are dropped until the whole thing fits in
 * a statement — a window, not a log.
 */
export function encodeThread(
  orderId: bigint,
  said: { at: number; text: string }[],
  archive?: string
): Uint8Array {
  const key = archive
    ? getBytes(archive.startsWith("0x") ? archive : `0x${archive}`)
    : null;
  if (key && key.length !== KEY_BYTES)
    throw new Error("that isn't a Bulletin key");
  const head = HEAD + (key ? KEY_BYTES : 0);

  const parts = said.map((m) => ({
    at: Math.floor(m.at / 1000),
    body: clip(m.text),
  }));
  let from = 0;
  const size = () =>
    parts.slice(from).reduce((n, p) => n + PER_MESSAGE + p.body.length, head);
  while (from < parts.length && size() > MAX_PAYLOAD) from++;

  const kept = parts.slice(from);
  const out = new Uint8Array(size());
  out.set(u64(orderId), 0);
  out[8] = key ? HAS_ARCHIVE : 0;
  if (key) out.set(key, HEAD);
  let at = head;
  for (const p of kept) {
    for (let i = 0; i < 4; i++)
      out[at + i] = Math.floor(p.at / 2 ** ((3 - i) * 8)) & 0xff;
    out[at + 4] = p.body.length;
    out.set(p.body, at + PER_MESSAGE);
    at += PER_MESSAGE + p.body.length;
  }
  return out;
}

export function decodeThread(bytes: Uint8Array): {
  orderId: bigint;
  said: { at: number; text: string }[];
  archive?: string;
} | null {
  if (bytes.length < HEAD) return null;
  const orderId = readU64(bytes);
  const hasArchive = (bytes[8] & HAS_ARCHIVE) !== 0;
  if (hasArchive && bytes.length < HEAD + KEY_BYTES) return null;
  const archive = hasArchive
    ? hexlify(bytes.slice(HEAD, HEAD + KEY_BYTES))
    : undefined;
  const said: { at: number; text: string }[] = [];
  let at = HEAD + (hasArchive ? KEY_BYTES : 0);
  while (at < bytes.length) {
    if (at + PER_MESSAGE > bytes.length) return null;
    // Multiplied, not shifted: a shift is signed 32-bit and would turn negative
    // the moment a timestamp passes 2038.
    const when =
      bytes[at] * 2 ** 24 +
      bytes[at + 1] * 2 ** 16 +
      bytes[at + 2] * 256 +
      bytes[at + 3];
    const length = bytes[at + 4];
    if (at + PER_MESSAGE + length > bytes.length) return null;
    try {
      said.push({
        at: when * 1000,
        text: toUtf8String(
          bytes.slice(at + PER_MESSAGE, at + PER_MESSAGE + length)
        ),
      });
    } catch {
      return null; // not text: not one of ours
    }
    at += PER_MESSAGE + length;
  }
  return { orderId, said, archive };
}

/** How many of these messages would be left behind by the window. */
export function dropsFrom(
  orderId: bigint,
  said: { at: number; text: string }[],
  archive?: string
): number {
  const kept = decodeThread(encodeThread(orderId, said, archive));
  return said.length - (kept?.said.length ?? 0);
}

/**
 * Say something. The whole window is republished on this side's own channel,
 * replacing what was there, so the other side sees the recent conversation
 * whether or not it was watching when each message was sent.
 */
export async function say(
  mine: Reader,
  theirs: string,
  orderId: bigint,
  text: string
): Promise<{ at: number; text: string }[]> {
  const trimmed = text.trim().slice(0, MAX_TEXT);
  if (!trimmed) throw new Error("nothing to say");
  const topic = threadTopic(mine.signingKey, theirs);
  const said = await rememberSaid(topic, trimmed);

  // A long conversation outgrows one statement, and the oldest of it would
  // simply be lost. Before that happens, the whole transcript goes to Bulletin,
  // sealed to the same reader, and the statement carries its key.
  //
  // This is deliberately NOT per message: a Bulletin write goes through the
  // host and may cost a tap, so it happens only when the window is about to
  // drop something that isn't stored yet — and it stores everything said so
  // far, which buys another windowful before the next one.
  const record = await threadRecord(topic);
  let archive = record?.archive;
  const dropped = dropsFrom(orderId, said, archive);
  if (dropped > (record?.archivedUpTo ?? 0)) {
    try {
      const key = await hostPut(
        await seal(theirs, ARCHIVE, encodeArchive(orderId, said))
      );
      await rememberArchive(topic, key, said.length);
      archive = key;
    } catch {
      // No Bulletin here, or the host refused: the window still works, and the
      // message still goes. The oldest messages age out, as they did before.
    }
  }

  await publishStatement(
    topic,
    sideChannel(topic, mine.signingKey),
    await seal(theirs, CHAT, encodeThread(orderId, said, archive))
  );
  return said;
}

/** The full transcript, as it goes to Bulletin: the same shape, no window. */
export function encodeArchive(
  orderId: bigint,
  said: { at: number; text: string }[]
): Uint8Array {
  const out = new Uint8Array(9 + said.length * (PER_MESSAGE + MAX_TEXT_BYTES));
  out.set(u64(orderId), 0);
  let at = HEAD;
  for (const m of said) {
    const body = clip(m.text);
    const when = Math.floor(m.at / 1000);
    for (let i = 0; i < 4; i++)
      out[at + i] = Math.floor(when / 2 ** ((3 - i) * 8)) & 0xff;
    out[at + 4] = body.length;
    out.set(body, at + PER_MESSAGE);
    at += PER_MESSAGE + body.length;
  }
  return out.slice(0, at);
}

/** Read a transcript fetched from Bulletin. */
export async function openArchive(
  mine: Reader,
  key: string
): Promise<{ at: number; text: string }[] | null> {
  const sealed = await hostGet(key);
  if (!sealed) return null;
  const plain = await open(mine, ARCHIVE, sealed);
  const read = plain && decodeThread(plain);
  return read ? read.said : null;
}

/**
 * Watch one thread. Calls back with the whole conversation, both sides, in
 * order — the other side as it arrives, this side from storage, and anything
 * that outgrew the window from Bulletin.
 */
export async function watchThread(
  mine: Reader,
  theirs: string,
  orderId: bigint,
  heard: (messages: Message[]) => void
): Promise<() => void> {
  const topic = threadTopic(mine.signingKey, theirs);
  let theirSide: { at: number; text: string }[] = [];
  let fetched: string | null = null;
  let older: { at: number; text: string }[] = [];

  const show = async () => {
    const ours = (await threadOf(topic)).map((m) => ({ ...m, mine: true }));
    // The archive holds everything they had said by the time it was written, so
    // the window may repeat some of it: keyed by time and text, not appended.
    const theirs = new Map<string, { at: number; text: string }>();
    for (const m of [...older, ...theirSide])
      theirs.set(`${m.at}:${m.text}`, m);
    heard(
      [
        ...ours,
        ...[...theirs.values()].map((m) => ({ ...m, mine: false })),
      ].sort((a, b) => a.at - b.at)
    );
  };
  await show();

  return subscribeTopics([topic], async (bytes) => {
    // Our own statements are sealed to them, so they don't open here — which is
    // exactly how a message is known to be theirs.
    const plain = await open(mine, CHAT, bytes);
    const read = plain && decodeThread(plain);
    if (!read || read.orderId !== orderId) return;
    theirSide = read.said;
    if (read.archive && read.archive !== fetched) {
      fetched = read.archive;
      older =
        (await openArchive(mine, read.archive).catch(() => null)) ?? older;
    }
    await show();
  });
}
