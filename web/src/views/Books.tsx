// The books, for whoever is looking at them.
//
// One screen serves all three roles because the questions are the same shape —
// what happened, what did it come to, get it out of here — and only the nouns
// differ. A venue sees sales, a driver earnings, a customer their own receipts.
//
// The export is the point of the screen. Everything above it is there so a
// person can tell at a glance whether the numbers are worth exporting.

import { useCallback, useEffect, useState } from "react";
import { itemsCsv, offer, ordersCsv } from "../books/csv";
import { closeDay } from "../books/backup";
import {
  closedDays,
  days,
  entriesOfDay,
  forgetKind,
  totalsOf,
  type EntryKind,
  type LedgerEntry,
} from "../books/ledger";
import { errorText, pasWei, short } from "../format";

const NOUN: Record<EntryKind, { one: string; many: string; title: string }> = {
  sale: { one: "sale", many: "sales", title: "Sales" },
  earning: { one: "job", many: "jobs", title: "Earnings" },
  purchase: { one: "order", many: "orders", title: "Your receipts" },
};

export function Books({
  kind,
  backup = false,
}: {
  kind: EntryKind;
  /** Offer the encrypted day-end backup. Books people must keep, not receipts. */
  backup?: boolean;
}) {
  const [all, setAll] = useState<string[]>([]);
  const [day, setDay] = useState<string | null>(null);
  const [rows, setRows] = useState<LedgerEntry[]>([]);
  const [closed, setClosed] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const ds = await days(kind);
      setAll(ds);
      setClosed(await closedDays());
      const pick = day && ds.includes(day) ? day : ds[0] ?? null;
      setDay(pick);
      setRows(pick ? await entriesOfDay(kind, pick) : []);
    } catch (e) {
      setError(errorText(e));
    }
  }, [kind, day]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const t = totalsOf(rows);
  const noun = NOUN[kind];

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    setNote(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const put = async (what: string, csv: string) => {
    setText(null);
    const how = await offer(csv);
    if (how === "copied") setNote(`${what} copied. Paste it into a spreadsheet.`);
    else {
      setText(csv);
      setNote(`${what} is below — this device wouldn't let me copy it.`);
    }
  };

  if (!all.length) {
    return (
      <div>
        <h3>{noun.title}</h3>
        <p className="muted">
          Nothing recorded yet. Every {noun.one} is written down here as it is
          charged, with the tax worked out at the time.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h3>{noun.title}</h3>

      <div className="actions">
        <label>
          Day{" "}
          <select
            value={day ?? ""}
            onChange={async (e) => {
              setDay(e.target.value);
              setRows(await entriesOfDay(kind, e.target.value));
            }}
          >
            {all.map((d) => (
              <option key={d} value={d}>
                {d}
                {closed.includes(d) ? " — backed up" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>

      <dl>
        <dt>{noun.many === "jobs" ? "Jobs" : "Orders"}</dt>
        <dd>{t.orders}</dd>
        {kind === "earning" ? (
          <>
            <dt>Earned</dt>
            <dd>{pasWei(t.net)}</dd>
          </>
        ) : (
          <>
            <dt>Goods</dt>
            <dd>{pasWei(t.goods)}</dd>
            <dt>Tax collected</dt>
            <dd>{pasWei(t.tax)}</dd>
            <dt>Total</dt>
            <dd>{pasWei(t.total)}</dd>
          </>
        )}
      </dl>

      {rows.some((r) => r.chainValue !== undefined && r.chainValue !== r.total) && (
        <p className="warn">
          Some {noun.many} don't match what the chain escrowed. Both numbers are
          in the export, marked NO in "matches chain".
        </p>
      )}

      <ul className="rows">
        {rows.map((r) => (
          <li key={`${r.kind}:${r.orderId}`}>
            <div>
              <b>#{r.orderId}</b>{" "}
              <span className="muted">
                {new Date(r.at).toLocaleTimeString()}
                {r.venue ? ` · ${r.venue}` : ""}
              </span>
            </div>
            {kind === "earning" ? (
              <p className="muted">
                fare {pasWei(BigInt(r.fare ?? "0"))} · tip{" "}
                {pasWei(BigInt(r.tip ?? "0"))} · fee {pasWei(BigInt(r.fee ?? "0"))}{" "}
                → {pasWei(BigInt(r.net ?? "0"))}
              </p>
            ) : (
              <p className="muted">
                {(r.lines ?? [])
                  .map((l) => `${l.count}x ${l.name}`)
                  .join(", ") || "no items recorded"}{" "}
                · {pasWei(BigInt(r.total ?? "0"))}
              </p>
            )}
          </li>
        ))}
      </ul>

      <h3>Get it out</h3>
      <p className="muted">
        Two files: one row per {noun.one} for the accounts, one row per item for
        stock. Amounts are in PAS, not wei, so a spreadsheet won't mangle them.
      </p>
      <div className="actions">
        <button disabled={!!busy} onClick={() => put("Orders", ordersCsv(rows))}>
          Copy {noun.many} CSV
        </button>
        {kind !== "earning" && (
          <button disabled={!!busy} onClick={() => put("Items", itemsCsv(rows))}>
            Copy items CSV
          </button>
        )}
      </div>

      {backup && day && (
        <>
          <h3>Close the day</h3>
          <p className="muted">
            Puts this day on Bulletin, encrypted with this device's own key, so
            a lost phone doesn't take the books with it. Whoever runs Bulletin
            sees noise. It costs one approval and takes up to half a minute.
          </p>
          {closed.includes(day) ? (
            <p className="ok">{day} is backed up.</p>
          ) : (
            <div className="actions">
              <button
                className="primary"
                disabled={!!busy || !rows.length}
                onClick={() =>
                  run(`Closing ${day}`, async () => {
                    const r = await closeDay(kind, day);
                    setNote(
                      `${r.rows} rows backed up. Keep this key somewhere off ` +
                        `this phone: ${r.bulletin}`
                    );
                  })
                }
              >
                Close {day}
              </button>
            </div>
          )}
        </>
      )}

      {kind === "purchase" && (
        <>
          <h3>Forget these</h3>
          <p className="muted">
            Your receipts are only on this device and are never backed up.
            Nothing else keeps a list of what you've ordered.
          </p>
          <div className="actions">
            <button
              disabled={!!busy}
              onClick={() =>
                run("Forgetting", async () => {
                  await forgetKind("purchase");
                  setRows([]);
                  setNote("Gone.");
                })
              }
            >
              Delete my receipts
            </button>
          </div>
        </>
      )}

      {busy && <p className="muted">{busy}…</p>}
      {note && <p className="ok">{note}</p>}
      {error && <p className="error">{error}</p>}
      {text && <textarea readOnly rows={10} value={text} />}
    </div>
  );
}

export { short };
