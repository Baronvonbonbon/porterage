// Restoring a backup, where the dangerous direction is obvious in hindsight.
//
// A backup is a photograph of the note book at one moment. Restoring it onto a
// phone that has been used since means merging a stale picture into a live one,
// and the failure that costs money is not "a note went missing" — it is a spent
// note coming back to life. The device would then build a proof for it, publish
// a nullifier, wait for a submitter and be told it was already spent, having
// shown the world a nullifier for nothing.

import { describe, expect, it } from "vitest";
import { mergeNotes, type NoteRecord } from "./notes";

const note = (n: number, over: Partial<NoteRecord> = {}): NoteRecord => ({
  n,
  value: "1000000000000000000",
  asset: "0",
  ...over,
});

const path = { leaf: 3, siblings: [] } as unknown as NoteRecord["path"];

describe("merging a backup in", () => {
  it("adds notes this device did not know about", () => {
    const { notes, added } = mergeNotes([note(0)], [note(0), note(1)]);
    expect(added).toBe(1);
    expect(notes.map((r) => r.n)).toEqual([0, 1]);
  });

  it("never un-spends a note the device knows is spent", () => {
    // The one that costs money. The backup predates the spend.
    const live = [note(0, { spent: true })];
    const stale = [note(0, { spent: false })];
    expect(mergeNotes(live, stale).notes[0].spent).toBe(true);
  });

  it("marks spent when only the BACKUP knows it", () => {
    // The other direction: this device was restored from an older state and
    // the backup is the one that saw the spend.
    const fresh = [note(0)];
    const knowing = [note(0, { spent: true })];
    expect(mergeNotes(fresh, knowing).notes[0].spent).toBe(true);
  });

  it("keeps a tree path from whichever copy has one", () => {
    // Without a path a note cannot be proved, so losing one on merge would
    // strand a live note that the backup could have located.
    expect(mergeNotes([note(0)], [note(0, { path })]).notes[0].path).toBe(path);
    expect(mergeNotes([note(0, { path })], [note(0)]).notes[0].path).toBe(path);
  });

  it("keeps an in-flight spend, so its fee is still paid", () => {
    const spending = {
      burner: 2,
      change: 9,
      since: 1,
      tip: "1",
    } as NoteRecord["spending"];
    expect(mergeNotes([note(0, { spending })], [note(0)]).notes[0].spending).toBe(
      spending
    );
    expect(mergeNotes([note(0)], [note(0, { spending })]).notes[0].spending).toBe(
      spending
    );
  });

  it("does not count a note it already had as added", () => {
    expect(mergeNotes([note(0), note(1)], [note(0), note(1)]).added).toBe(0);
  });

  it("restores onto an empty device", () => {
    const { notes, added } = mergeNotes([], [note(0), note(1), note(2)]);
    expect(added).toBe(3);
    expect(notes.length).toBe(3);
  });

  it("leaves a device alone when the backup is empty", () => {
    const mine = [note(0, { spent: true }), note(1)];
    const { notes, added } = mergeNotes(mine, []);
    expect(added).toBe(0);
    expect(notes).toEqual(mine);
  });

  it("returns notes in order, whatever order they arrived in", () => {
    const { notes } = mergeNotes([note(5)], [note(2), note(9)]);
    expect(notes.map((r) => r.n)).toEqual([2, 5, 9]);
  });

  it("is idempotent — restoring the same backup twice changes nothing", () => {
    const mine = [note(0, { spent: true }), note(1, { path })];
    const backup = [note(0), note(1), note(2)];
    const once = mergeNotes(mine, backup);
    const twice = mergeNotes(once.notes, backup);
    expect(twice.added).toBe(0);
    expect(twice.notes).toEqual(once.notes);
  });
});
