// Backing up the note book, on whichever screen holds money.
//
// One component rather than two copies, because this is the block most likely
// to be read once and acted on months later, and two copies drift into saying
// slightly different things about what is and is not at risk.

import { useState } from "react";
import { backupNotes, restoreNotes } from "../shield/recover";
import { errorText } from "../format";

export function NoteBackup() {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(label: string, fn: () => Promise<string>) {
    setBusy(label);
    setError(null);
    setDone(null);
    try {
      setDone(await fn());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <h3>If you lose this phone</h3>
      <p className="muted">
        Your notes are worked out from your Polkadot account, so they aren't
        lost with the device — but the list of which ones you hold is, and
        without it a new phone has the keys and can't find the money. This puts
        that list on Bulletin, encrypted with your own account's key. Whoever
        runs Bulletin sees noise, and only this account can read it back.
      </p>
      <div className="actions">
        <button
          disabled={!!busy}
          onClick={() =>
            run("Backing up", async () => {
              const r = await backupNotes();
              return (
                `${r.notes} notes backed up. Keep this key somewhere that ` +
                `isn't this phone: ${r.bulletin}`
              );
            })
          }
        >
          Back up my notes
        </button>
      </div>
      <div className="actions">
        <label>
          Restore from{" "}
          <input
            value={key}
            placeholder="0x…"
            size={18}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        <button
          disabled={!!busy || !key.trim()}
          onClick={() =>
            run("Restoring", async () => {
              const r = await restoreNotes(key.trim());
              setKey("");
              return r.added
                ? `Added ${r.added} notes this phone didn't have.`
                : `Nothing new — this phone already had all ${r.total}.`;
            })
          }
        >
          Restore
        </button>
      </div>
      <p className="muted">
        Restoring merges: it adds what's missing and never marks a spent note
        unspent, so restoring an old backup onto a phone you've kept using is
        safe.
      </p>
      {busy && <p className="muted">{busy}…</p>}
      {done && <p className="ok">{done}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
