// Closing the day: the books, encrypted, somewhere a lost phone cannot take
// them.
//
// WHY THIS IS A BUTTON AND NOT AUTOMATIC. A Bulletin write was measured on a
// real phone at a host approval prompt EVERY time and 31.5 s then 5.6 s
// (probe.ts, 2026-09-21). Backing up per order would put a prompt and half a
// minute between a counter and its next customer. So a day's rows go up in one
// blob, once, when the venue says the day is done — which is also when a person
// who keeps books would expect to do it.
//
// WHAT BULLETIN HOLDS IS NOISE. The blob is AES-GCM under a key derived from
// this device's own entropy, so a venue's sales are not readable by whoever
// runs Bulletin, by anyone fetching the URI, or by us. The trade that buys is
// the ordinary one for encrypted backups: lose the device's key material and
// the backup is lost with it. It protects against a dropped phone, not against
// a forgotten seed.
//
// WHY NOT CUSTOMERS. A venue and a driver have books they are obliged to keep,
// and losing them is a real problem with a tax authority at the end of it. A
// customer has no such obligation, and a durable, backed-up, itemised history
// of everything a person has ever eaten is the single most sensitive record
// this design could create. Their receipts stay on the device, where they can
// read them, export them, and throw them away.

import { hostGet, hostPut } from "../host";
import { entropy, LABEL } from "../keys";
import {
  allEntries,
  dayOf,
  markClosed,
  type EntryKind,
  type LedgerEntry,
} from "./ledger";

const VERSION = 1;

let aes: Promise<CryptoKey> | null = null;
const backupKey = () =>
  (aes ??= entropy(LABEL.booksBackup).then((m) =>
    crypto.subtle.importKey("raw", m as BufferSource, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ])
  ));

interface Blob {
  v: number;
  day: string;
  kind: EntryKind;
  entries: LedgerEntry[];
}

/**
 * Put one day's rows on Bulletin, encrypted, and remember it was done.
 *
 * Returns the Bulletin key. It is worth keeping somewhere outside the phone —
 * written down, mailed to an accountant — because the whole point is to survive
 * the phone, and a URI that only exists on the device it is backing up is not a
 * backup.
 */
export async function closeDay(
  kind: EntryKind,
  day: string
): Promise<{ bulletin: string; rows: number }> {
  const entries = (await allEntries()).filter(
    (e) => e.kind === kind && dayOf(e.at) === day
  );
  if (!entries.length) throw new Error(`nothing recorded on ${day}`);

  const blob: Blob = { v: VERSION, day, kind, entries };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await backupKey(),
      new TextEncoder().encode(JSON.stringify(blob)) as BufferSource
    )
  );
  const sealed = new Uint8Array(12 + body.length);
  sealed.set(iv, 0);
  sealed.set(body, 12);

  const bulletin = await hostPut(sealed);
  await markClosed(day);
  return { bulletin, rows: entries.length };
}

/** Read a day back, on this device or another one holding the same key. */
export async function openDay(bulletin: string): Promise<LedgerEntry[]> {
  const sealed = await hostGet(bulletin);
  if (!sealed?.length) throw new Error("nothing at that key");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: sealed.slice(0, 12) as BufferSource },
    await backupKey(),
    sealed.slice(12) as BufferSource
  );
  const blob = JSON.parse(new TextDecoder().decode(plain)) as Blob;
  if (blob.v !== VERSION) throw new Error("a backup this app cannot read");
  return blob.entries;
}
