// The driver's side of the auction (docs/PLAN.md §4 step 2).
//
// Open orders are read straight from the contract — no event log, so orders
// placed from any kind of account show up. Bidding is two steps with no taps:
// the session key commits the hash on-chain, and the terms go to the customer
// encrypted, so nobody else learns who bid what.

import { useCallback, useEffect, useState } from "react";
import type { Wallet } from "ethers";
import { customerKeyOf, placeBid } from "../order/bids";
import { recentOrders, Status, type Order } from "../order/orders";
import { venueOf, type Venue } from "../order/venue";
import { formatDegrees } from "../order/geo";
import { errorText, pasWei } from "../format";

export function Jobs({ sessionKey, driver }: { sessionKey: Wallet; driver: string }) {
  const [open, setOpen] = useState<Order[]>([]);
  const [venues, setVenues] = useState<Map<string, Venue>>(new Map());
  const [mine, setMine] = useState<Order[]>([]);
  const [amounts, setAmounts] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const all = await recentOrders();
      setOpen(all.filter((o) => o.status === Status.Open));
      setMine(all.filter((o) => o.driver.toLowerCase() === driver.toLowerCase() && o.status >= Status.Assigned));
      const ids = [...new Set(all.map((o) => o.venueId.toString()))];
      setVenues(new Map(await Promise.all(ids.map(async (id) => [id, await venueOf(BigInt(id))] as const))));
    } catch (e) {
      setError(errorText(e));
    }
  }, [driver]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function bid(o: Order) {
    const text = amounts.get(o.id.toString()) ?? "";
    const amount = BigInt(Math.round(Number(text) * 1e6)) * 10n ** 12n;
    if (!(amount > 0n) || amount > o.maxFare) {
      setError(`Bid something above zero and at most ${pasWei(o.maxFare)}.`);
      return;
    }
    setBusy(`Bidding on #${o.id}`);
    setError(null);
    setNote(null);
    try {
      const key = await customerKeyOf(o.id);
      if (!key) throw new Error("this order's account hasn't published a key to bid to yet");
      await placeBid(sessionKey, o.id, driver, amount, key);
      setNote(`Bid ${pasWei(amount)} on #${o.id}. The customer sees it privately and may take any bid.`);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <h3>Work</h3>
      {open.length === 0 && <p className="muted">No orders are open right now.</p>}
      {open.map((o) => {
        const v = venues.get(o.venueId.toString());
        return (
          <div key={o.id.toString()} className="actions">
            <p>
              <b>#{o.id.toString()}</b> — collect from venue #{o.venueId.toString()}
              {v && ` at ${formatDegrees(v.at.lat)}, ${formatDegrees(v.at.lon)}`}, goods {pasWei(o.orderValue)}, pays up
              to {pasWei(o.maxFare)}
            </p>
            <label>
              Bid{" "}
              <input
                inputMode="decimal"
                size={5}
                value={amounts.get(o.id.toString()) ?? ""}
                onChange={(e) => setAmounts(new Map(amounts).set(o.id.toString(), e.target.value))}
              />{" "}
              PAS
            </label>
            <button disabled={!!busy} onClick={() => bid(o)}>
              Bid on #{o.id.toString()}
            </button>
          </div>
        );
      })}

      {mine.length > 0 && (
        <>
          <h3>Yours</h3>
          <ul>
            {mine.map((o) => (
              <li key={o.id.toString()}>
                #{o.id.toString()} — {pasWei(o.fare)} from venue #{o.venueId.toString()}
              </li>
            ))}
          </ul>
          <p className="muted">Collection and handover by QR arrive next.</p>
        </>
      )}

      {busy && <p className="muted">{busy}…</p>}
      {note && <p className="ok">{note}</p>}
      {error && <p className="error">{error}</p>}
      <button className="link" onClick={refresh} disabled={!!busy}>
        Refresh work
      </button>
    </div>
  );
}
