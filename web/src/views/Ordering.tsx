// Placing an order and running its auction (docs/PLAN.md §4 steps 1–2).
//
// Everything here is signed by the order's own fresh account, so no tap is
// needed once it's funded — and nothing on-chain ties the order to the phone.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Wallet } from "ethers";
import { deployed } from "../contracts";
import { allVenues, type Venue } from "../order/venue";
import { formatDegrees, parseDegrees } from "../order/geo";
import { acceptBid, cancelOrder, orderOf, statusName, type Order } from "../order/orders";
import { watchBids, type Bid } from "../order/bids";
import { fundingFor, orderBurner, placeOrder, type PlaceStage } from "../order/flow";
import { allOrders, type OrderRecord } from "../shield/notes";
import { errorText, pasWei, short } from "../format";

const PAS = 10n ** 18n;

const STAGE_TEXT: Record<PlaceStage, string> = {
  proving: "Proving the withdrawal on this phone",
  posting: "Posting the funding request",
  waiting: "Waiting for someone to fund the order account",
  settling: "Recording the change note",
  tipping: "Tipping whoever funded it",
  done: "Funded",
  creating: "Creating the order",
  announcing: "Telling drivers where to send bids",
  placed: "Placed",
};

export function Ordering() {
  const [venues, setVenues] = useState<Venue[]>([]);
  const [venueId, setVenueId] = useState<string>("");
  const [goods, setGoods] = useState("1");
  const [maxFare, setMaxFare] = useState("2");
  const [lat, setLat] = useState("37.784900");
  const [lon, setLon] = useState("-122.419400");
  const [mine, setMine] = useState<OrderRecord[]>([]);
  const [live, setLive] = useState<{ record: OrderRecord; order: Order; burner: Wallet } | null>(null);
  const [bids, setBids] = useState<Bid[]>([]);
  const [stage, setStage] = useState<PlaceStage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef<(() => void) | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      if (!deployed()) return;
      setVenues((await allVenues()).filter((v) => v.active));
      const records = await allOrders();
      setMine(records.sort((a, b) => b.placedAt - a.placedAt));
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    return () => stop.current?.();
  }, [refresh]);

  const openOrder = useCallback(async (record: OrderRecord) => {
    stop.current?.();
    setBids([]);
    const [order, burner] = await Promise.all([orderOf(BigInt(record.id)), orderBurner(record)]);
    setLive({ record, order, burner });
    stop.current = await watchBids(burner, BigInt(record.id), (bid) =>
      setBids((all) => [...all.filter((b) => b.bidHash !== bid.bidHash), bid].sort((a, b) => (a.amount < b.amount ? -1 : 1))),
    );
  }, []);

  const drop = { lat: parseDegrees(lat), lon: parseDegrees(lon) };
  const plan =
    venueId && drop.lat !== null && drop.lon !== null
      ? {
          venueId: BigInt(venueId),
          drop: { lat: drop.lat, lon: drop.lon },
          orderValue: BigInt(Math.round(Number(goods) * 1e6)) * 10n ** 12n,
          tip: 0n,
          maxFare: BigInt(Math.round(Number(maxFare) * 1e6)) * 10n ** 12n,
        }
      : null;

  async function place() {
    if (!plan) return;
    setError(null);
    try {
      const { record } = await placeOrder(plan, setStage);
      await refresh();
      await openOrder(record);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setStage(null);
    }
  }

  async function take(bid: Bid) {
    if (!live) return;
    setBusy(`Accepting ${pasWei(bid.amount)}`);
    setError(null);
    try {
      await acceptBid(live.burner, BigInt(live.record.id), bid.driver, bid.amount, bid.salt);
      await openOrder(live.record);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h2>Order</h2>

      {!live && (
        <>
          {venues.length === 0 ? (
            <p className="notice">No venues have registered yet. Open Sell on another phone to add one.</p>
          ) : (
            <div className="actions">
              <label>
                From{" "}
                <select value={venueId} onChange={(e) => setVenueId(e.target.value)}>
                  <option value="">choose a venue</option>
                  {venues.map((v) => (
                    <option key={v.id.toString()} value={v.id.toString()}>
                      #{v.id.toString()} at {formatDegrees(v.at.lat)}, {formatDegrees(v.at.lon)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Goods worth <input inputMode="decimal" value={goods} onChange={(e) => setGoods(e.target.value)} size={5} /> PAS
              </label>
              <label>
                Pay up to <input inputMode="decimal" value={maxFare} onChange={(e) => setMaxFare(e.target.value)} size={5} /> PAS
                to deliver
              </label>
              <label>
                Drop at <input inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} size={11} />
                <input inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} size={11} />
              </label>
              {plan && (
                <p className="muted">
                  Needs {pasWei(fundingFor(plan))} in one note: the goods, the fare and its own gas. The drop stays on
                  this phone — the order carries only a commitment to it.
                </p>
              )}
              <button disabled={!plan || !!stage} onClick={place}>
                Place the order
              </button>
            </div>
          )}
          {stage && <p className="muted">{STAGE_TEXT[stage]}…</p>}

          {mine.length > 0 && (
            <>
              <h3>Your orders</h3>
              <ul>
                {mine.map((r) => (
                  <li key={r.id}>
                    <button className="link" onClick={() => openOrder(r)}>
                      #{r.id} — {new Date(r.placedAt).toLocaleString()}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {live && (
        <>
          <dl>
            <dt>Order</dt>
            <dd>#{live.record.id}</dd>
            <dt>State</dt>
            <dd>{statusName(live.order.status)}</dd>
            <dt>From venue</dt>
            <dd>#{live.order.venueId.toString()}</dd>
            <dt>Ordering account</dt>
            <dd title={live.burner.address}>{short(live.burner.address)}</dd>
            <dt>Drop</dt>
            <dd>
              {formatDegrees(live.record.lat)}, {formatDegrees(live.record.lon)} <span className="muted">(kept here)</span>
            </dd>
            {live.order.driver !== "0x0000000000000000000000000000000000000000" && (
              <>
                <dt>Driver</dt>
                <dd title={live.order.driver}>
                  {short(live.order.driver)} for {pasWei(live.order.fare)}
                </dd>
              </>
            )}
          </dl>

          {live.order.status === 1 && (
            <>
              <h3>Bids</h3>
              {bids.length === 0 && <p className="muted">Waiting for drivers to bid…</p>}
              <div className="actions">
                {bids.map((b) => (
                  <button key={b.bidHash} disabled={!!busy || !b.standing} onClick={() => take(b)}>
                    {pasWei(b.amount)} — {short(b.driver)}
                    {b.standing ? "" : " (withdrawn)"}
                  </button>
                ))}
              </div>
              <button
                className="link"
                disabled={!!busy}
                onClick={() =>
                  cancelOrder(live.burner, BigInt(live.record.id))
                    .then(() => openOrder(live.record))
                    .catch((e) => setError(errorText(e)))
                }
              >
                Cancel this order
              </button>
            </>
          )}

          {live.order.status >= 2 && <p className="muted">Collection and handover by QR arrive next.</p>}

          <button
            className="link"
            onClick={() => {
              stop.current?.();
              setLive(null);
              refresh();
            }}
          >
            Back
          </button>
        </>
      )}

      {busy && <p className="muted">{busy}…</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
