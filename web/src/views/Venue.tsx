// The venue counter (docs/PLAN.md §4 step 3): register once, then take orders.

import { useCallback, useEffect, useState } from "react";
import type { Wallet } from "ethers";
import { hostAccount, type HostAccount } from "../hostchain";
import { sessionKey } from "../keys";
import { deployed } from "../contracts";
import { allVenues, myVenues, registerVenue, setVenueSigner, type Venue as VenueRow } from "../order/venue";
import { formatDegrees, parseDegrees } from "../order/geo";
import { recentOrders, Status, statusName, type Order } from "../order/orders";
import { encodePickup, nowSeconds, signPickup } from "../order/handoff";
import { QrShow } from "./Qr";
import { errorText, pasWei, short } from "../format";

export function Venue() {
  const [me, setMe] = useState<HostAccount | null>(null);
  const [key, setKey] = useState<Wallet | null>(null);
  const [mine, setMine] = useState<VenueRow[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [lat, setLat] = useState("37.774900");
  const [lon, setLon] = useState("-122.419400");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<{ id: string; text: string } | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [acct, k] = await Promise.all([hostAccount(), sessionKey(0)]);
      setMe(acct);
      setKey(k);
      if (deployed()) {
        const rows = await myVenues(acct.evm);
        setMine(rows);
        const ids = new Set(rows.map((v) => v.id.toString()));
        setOrders((await recentOrders()).filter((o) => ids.has(o.venueId.toString())));
        if (!rows.length) await allVenues(1); // warms the read path
      }
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const at = { lat: parseDegrees(lat), lon: parseDegrees(lon) };
  const valid = at.lat !== null && at.lon !== null;

  return (
    <section>
      <h2>Sell</h2>

      {mine.length === 0 && (
        <>
          <p className="muted">
            Register the counter once, at its own position. Drivers prove they collected from here by both signing
            that position, so it never needs the phone's location afterwards.
          </p>
          <div className="actions">
            <label>
              Latitude <input inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} size={11} />
            </label>
            <label>
              Longitude <input inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} size={11} />
            </label>
            <button
              disabled={!!busy || !valid || !key}
              onClick={() => run("Registering", () => registerVenue({ lat: at.lat!, lon: at.lon! }, key!))}
            >
              Register this venue
            </button>
          </div>
        </>
      )}

      {mine.map((v) => (
        <dl key={v.id.toString()}>
          <dt>Venue</dt>
          <dd>#{v.id.toString()}</dd>
          <dt>Counter at</dt>
          <dd>
            {formatDegrees(v.at.lat)}, {formatDegrees(v.at.lon)}
          </dd>
          <dt>Signs with</dt>
          <dd title={v.signer}>
            {key && v.signer.toLowerCase() === key.address.toLowerCase() ? (
              "this phone"
            ) : (
              <>
                {short(v.signer)}{" "}
                <button className="link" disabled={!!busy || !key} onClick={() => run("Updating", () => setVenueSigner(v.id, key!))}>
                  use this phone
                </button>
              </>
            )}
          </dd>
        </dl>
      ))}

      {mine.length > 0 && (
        <>
          <h3>Orders</h3>
          {orders.length === 0 && <p className="muted">No orders yet.</p>}
          <ul>
            {orders.map((o) => {
              const venue = mine.find((v) => v.id === o.venueId)!;
              return (
                <li key={o.id.toString()}>
                  #{o.id.toString()} — {statusName(o.status)}, goods {pasWei(o.orderValue)}
                  {o.driver !== "0x0000000000000000000000000000000000000000" && ` — driver ${short(o.driver)}`}
                  {o.status === Status.Assigned && key && (
                    <>
                      {" "}
                      <button
                        className="link"
                        disabled={!!busy}
                        onClick={() =>
                          run("Signing the handover", async () => {
                            const timestamp = nowSeconds();
                            const signature = await signPickup(key, o.id, key.address, venue.at, timestamp);
                            setCode({
                              id: o.id.toString(),
                              text: encodePickup({ orderId: o.id, at: venue.at, timestamp, signature }),
                            });
                          })
                        }
                      >
                        hand it over
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>

          {code && (
            <>
              <h3>Order #{code.id}</h3>
              <QrShow value={code.text} caption="Let the driver scan this. It's the counter's signature, and it's good for a few minutes." />
              <button className="link" onClick={() => setCode(null)}>
                Done
              </button>
            </>
          )}
        </>
      )}

      {me && !deployed() && <p className="notice">The contracts aren't deployed yet.</p>}
      {busy && <p className="muted">{busy}… approve it in the Polkadot app.</p>}
      {error && <p className="error">{error}</p>}
      <button className="link" onClick={refresh} disabled={!!busy}>
        Refresh
      </button>
    </section>
  );
}
