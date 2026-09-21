// Surviving a lost phone.
//
// This module exists because of an asymmetry that was the wrong way round: the
// BOOKS got an encrypted backup (books/backup.ts) before the MONEY did. A venue
// that dropped its phone kept its sales records and lost its takings.
//
// WHAT IS AND IS NOT AT RISK. A note's secrets are DERIVED, not stored —
// `deriveEntropy("porterage:note:<n>")` returns the same thing on every device
// the host account is on. So the secrets are never lost while the account
// exists. What is lost is the BOOKKEEPING: which note numbers are in use, what
// each is worth, where it sits in the tree, and which are already spent. Without
// that a device holds the keys to money it cannot find.
//
// notes.ts says in its own header that the notes "can be found again by
// recomputing commitments and looking for them in the pool". That is true and
// nothing implements it, so it is a design intention rather than a recovery
// path. A rescan is also only half an answer here: the pool's ABI exposes
// `NewCommitment` but no way to ask whether a nullifier is spent, so a rescan
// would find every note this account ever had and could not say which were
// already gone. It would resurrect spent notes, and the device would go on to
// prove one, wait for a submitter, and be told "Nullifier already spent" —
// having published a nullifier for nothing.
//
// So: a backup, which keeps the spent flags exactly.
//
// IT ADDS NO NEW TRUST. The blob is encrypted under this account's own derived
// entropy, so restoring it needs the same host account that could derive the
// note secrets anyway. Whoever can read the backup could already have spent the
// money; they just could not have found it. Bulletin holds noise.

import { hostGet, hostPut } from "../host";
import { entropy, LABEL } from "../keys";
import { exportBook, mergeBook, type Book } from "./notes";

const VERSION = 1;

let aes: Promise<CryptoKey> | null = null;
const backupKey = () =>
  (aes ??= entropy(LABEL.notesBackup).then((m) =>
    crypto.subtle.importKey("raw", m as BufferSource, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ])
  ));

interface Blob {
  v: number;
  at: number;
  book: Book;
}

/**
 * Put the note book on Bulletin, encrypted, and return its key.
 *
 * The key is the whole thing to keep. Written down, mailed to yourself, in a
 * password manager — anywhere that is not this phone, because a backup whose
 * address only exists on the device it backs up is not a backup.
 */
export async function backupNotes(): Promise<{
  bulletin: string;
  notes: number;
}> {
  const book = await exportBook();
  const blob: Blob = { v: VERSION, at: Date.now(), book };
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
  return { bulletin: await hostPut(sealed), notes: book.notes.length };
}

/**
 * Read a backup and merge it in.
 *
 * MERGE, never replace. A device that has been used since the backup was taken
 * knows things the backup does not — notes spent, change settled — and throwing
 * that away to "restore" would be a good way to lose money on the device that
 * still had it. `mergeBook` keeps spent one-way for the same reason.
 */
export async function restoreNotes(
  bulletin: string
): Promise<{ added: number; total: number }> {
  const sealed = await hostGet(bulletin);
  if (!sealed?.length) throw new Error("nothing at that key");
  let blob: Blob;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: sealed.slice(0, 12) as BufferSource },
      await backupKey(),
      sealed.slice(12) as BufferSource
    );
    blob = JSON.parse(new TextDecoder().decode(plain)) as Blob;
  } catch {
    // The usual cause is a backup made by a different account, which cannot be
    // read here and never will be. Say that, rather than "decryption failed".
    throw new Error(
      "this device can't read that backup — it was made by a different account"
    );
  }
  if (blob.v !== VERSION) throw new Error("a backup this app cannot read");
  const added = await mergeBook(blob.book);
  return { added, total: blob.book.notes.length };
}
