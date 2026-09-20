// The driver's side of the auction (docs/PLAN.md §4 step 2).
//
// Open orders are read straight from the contract — no event log, so orders
// placed from any kind of account show up. Bidding is two steps with no taps:
// the session key commits the hash on-chain, and the terms go to the customer
// encrypted, so nobody else learns who bid what.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Wallet } from "ethers";
import { customerKeyOf, orderTopic, placeBid } from "../order/bids";
import { recentOrders, Status, type Order } from "../order/orders";
import { venueOf, type Venue } from "../order/venue";
import {
  confirmPickup,
  decodePayload,
  encodeDropSignature,
  nowSeconds,
  signDropCommit,
} from "../order/handoff";
import { QrScan, QrShow } from "./Qr";
import { Thread } from "./Thread";
import { introduce } from "../order/chat";
import { fileDisputeAsDriver } from "../order/dispute";
import { driverRating, ratingText } from "../order/ratings";
import { Camera } from "./Camera";
import { commitPhoto } from "../order/evidence";
import { formatDegrees } from "../order/geo";
import { errorText, pasWei } from "../format";

export function Jobs({
  sessionKey,
  driver,
}: {
  sessionKey: Wallet;
  driver: string;
}) {
  const [open, setOpen] = useState<Order[]>([]);
  const [venues, setVenues] = useState<Map<string, Venue>>(new Map());
  const [mine, setMine] = useState<Order[]>([]);
  const [amounts, setAmounts] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState<null | {
    order: Order;
    kind: "pickup" | "dropRequest";
  }>(null);
  const [handback, setHandback] = useState<{ id: string; text: string } | null>(
    null
  );
  const [photoFor, setPhotoFor] = useState<Order | null>(null);
  /** Order id to the customer's key, once we've said hello on that order. */
  const [talking, setTalking] = useState<Map<string, string>>(new Map());
  const [talkTo, setTalkTo] = useState<Order | null>(null);
  const greeted = useRef(new Set<string>());
  const [rating, setRating] = useState<string>("…");
  const [complaint, setComplaint] = useState<{
    order: Order;
    text: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const all = await recentOrders();
      setOpen(all.filter((o) => o.status === Status.Open));
      setMine(
        all.filter(
          (o) =>
            o.driver.toLowerCase() === driver.toLowerCase() &&
            o.status >= Status.Assigned
        )
      );
      const ids = [...new Set(all.map((o) => o.venueId.toString()))];
      setVenues(
        new Map(
          await Promise.all(
            ids.map(async (id) => [id, await venueOf(BigInt(id))] as const)
          )
        )
      );
      await greet(
        all.filter(
          (o) =>
            o.driver.toLowerCase() === driver.toLowerCase() &&
            o.status === Status.Assigned
        )
      );
    } catch (e) {
      setError(errorText(e));
    }
  }, [driver]);

  /**
   * Say hello on a job just taken, so the customer can message the driver
   * without the driver opening anything first. It's the driver's session key
   * that's handed over, which is also the key the photo at the door is sealed
   * with — the customer would recover it there anyway.
   */
  async function greet(jobs: Order[]) {
    for (const o of jobs) {
      const id = o.id.toString();
      if (greeted.current.has(id)) continue;
      greeted.current.add(id);
      try {
        const key = await customerKeyOf(o.id);
        if (!key) continue;
        await introduce(sessionKey, key, orderTopic(o.id), o.id, "driver");
        setTalking((m) => new Map(m).set(id, key));
      } catch {
        greeted.current.delete(id); // offline, or the store refused: try again next refresh
      }
    }
  }

  /**
   * A driver disputes from its OWN address, not the session key: the contract
   * asks for a party to the order, and the session key acts for the driver only
   * where it was given that right. It costs a tap, which a dispute is worth.
   */
  async function fileComplaint() {
    if (!complaint?.text.trim()) return;
    setBusy(`Filing on #${complaint.order.id}`);
    setError(null);
    try {
      await fileDisputeAsDriver(complaint.order.id, { reason: complaint.text });
      setComplaint(null);
      setNote("Filed. The escrow is held until an arbiter rules.");
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

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
      if (!key)
        throw new Error(
          "this order's account hasn't published a key to bid to yet"
        );
      await placeBid(sessionKey, o.id, driver, amount, key);
      setNote(
        `Bid ${pasWei(amount)} on #${
          o.id
        }. The customer sees it privately and may take any bid.`
      );
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function collected(o: Order, text: string) {
    setScanning(null);
    setBusy(`Collecting #${o.id}`);
    setError(null);
    try {
      const code = decodePayload(text);
      if (code.kind !== "pickup" || code.orderId !== o.id)
        throw new Error("that code is for another order");
      const venue = venues.get(o.venueId.toString());
      if (!venue) throw new Error("couldn't read the venue");
      await confirmPickup(sessionKey, driver, code, venue.signer);
      setNote(`Collected #${o.id}. The venue has been paid.`);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function atTheDoor(o: Order, text: string) {
    setScanning(null);
    setBusy(`Signing for #${o.id}`);
    setError(null);
    try {
      const code = decodePayload(text);
      if (code.kind !== "dropRequest" || code.orderId !== o.id)
        throw new Error("that code is for another order");
      const timestamp = nowSeconds();
      const signature = await signDropCommit(
        sessionKey,
        o.id,
        driver,
        code.posCommit,
        timestamp
      );
      setHandback({
        id: o.id.toString(),
        text: encodeDropSignature({ orderId: o.id, timestamp, signature }),
      });
      setPhotoFor(o);
      setNote(
        "Show this back to the customer. You signed their code without learning the address."
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function photographed(o: Order, jpeg: Uint8Array) {
    setPhotoFor(null);
    setBusy("Storing the photo");
    setError(null);
    try {
      const key = await customerKeyOf(o.id);
      if (!key) throw new Error("this order's account hasn't published a key");
      const { bytes } = await commitPhoto(sessionKey, o.id, key, jpeg);
      setNote(
        `Photo stored, sealed to the customer (${(bytes / 1024).toFixed(
          0
        )} kB), and its key is on-chain.`
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  if (photoFor) {
    return (
      <div>
        <h3>Photograph the delivery</h3>
        <p className="muted">
          Only you and this customer can open it. Its key goes on-chain now,
          before the order settles, so it counts as evidence if anything is
          disputed later.
        </p>
        <Camera
          onCancel={() => setPhotoFor(null)}
          onTaken={(jpeg) => photographed(photoFor, jpeg)}
        />
      </div>
    );
  }

  if (scanning) {
    return (
      <div>
        <h3>
          {scanning.kind === "pickup"
            ? "Scan the counter's code"
            : "Scan the customer's code"}
        </h3>
        <QrScan
          expect={scanning.kind}
          onCancel={() => setScanning(null)}
          onRead={(text) =>
            scanning.kind === "pickup"
              ? collected(scanning.order, text)
              : atTheDoor(scanning.order, text)
          }
        />
      </div>
    );
  }

  if (handback) {
    return (
      <div>
        <h3>Order #{handback.id}</h3>
        <QrShow
          value={handback.text}
          caption="The customer scans this to finish the delivery and release your fare."
        />
        <button
          className="link"
          onClick={() => {
            setHandback(null);
            refresh();
          }}
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <div>
      <h3>Work</h3>
      <p className="muted">Your rating: {rating}</p>
      {open.length === 0 && (
        <p className="muted">No orders are open right now.</p>
      )}
      {open.map((o) => {
        const v = venues.get(o.venueId.toString());
        return (
          <div key={o.id.toString()} className="actions">
            <p>
              <b>#{o.id.toString()}</b> — collect from venue #
              {o.venueId.toString()}
              {v &&
                ` at ${formatDegrees(v.at.lat)}, ${formatDegrees(v.at.lon)}`}
              , goods {pasWei(o.orderValue)}, pays up to {pasWei(o.maxFare)}
            </p>
            <label>
              Bid{" "}
              <input
                inputMode="decimal"
                size={5}
                value={amounts.get(o.id.toString()) ?? ""}
                onChange={(e) =>
                  setAmounts(
                    new Map(amounts).set(o.id.toString(), e.target.value)
                  )
                }
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
                #{o.id.toString()} — {pasWei(o.fare)} from venue #
                {o.venueId.toString()}
                {o.status === Status.Assigned && (
                  <>
                    {" "}
                    <button
                      className="link"
                      disabled={!!busy}
                      onClick={() => setScanning({ order: o, kind: "pickup" })}
                    >
                      collect it
                    </button>
                  </>
                )}
                {o.status === Status.PickedUp && (
                  <>
                    {" "}
                    <button
                      className="link"
                      disabled={!!busy}
                      onClick={() =>
                        setScanning({ order: o, kind: "dropRequest" })
                      }
                    >
                      deliver it
                    </button>
                  </>
                )}
                {talking.get(o.id.toString()) &&
                  o.status < Status.Delivered && (
                    <>
                      {" "}
                      <button
                        className="link"
                        onClick={() =>
                          setTalkTo(talkTo?.id === o.id ? null : o)
                        }
                      >
                        {talkTo?.id === o.id ? "hide messages" : "messages"}
                      </button>
                    </>
                  )}
                {o.status < Status.Delivered && (
                  <>
                    {" "}
                    <button
                      className="link"
                      disabled={!!busy}
                      onClick={() =>
                        setComplaint(
                          complaint?.order.id === o.id
                            ? null
                            : { order: o, text: "" }
                        )
                      }
                    >
                      {complaint?.order.id === o.id
                        ? "never mind"
                        : "something's wrong"}
                    </button>
                  </>
                )}
                {o.status >= Status.Delivered && " — delivered"}
                {complaint?.order.id === o.id && (
                  <div className="actions">
                    <label>
                      What happened{" "}
                      <input
                        value={complaint.text}
                        maxLength={200}
                        onChange={(e) =>
                          setComplaint({ order: o, text: e.target.value })
                        }
                        placeholder="Nobody at the address"
                      />
                    </label>
                    <p className="muted">
                      This freezes the money until an arbiter rules, and only
                      the arbiter can read it. It's signed by your own account,
                      so it takes a tap.
                    </p>
                    <button
                      disabled={!!busy || !complaint.text.trim()}
                      onClick={fileComplaint}
                    >
                      File it
                    </button>
                  </div>
                )}
                {talkTo?.id === o.id && talking.get(o.id.toString()) && (
                  <Thread
                    mine={sessionKey}
                    theirs={talking.get(o.id.toString())!}
                    orderId={o.id}
                    title={`You and the customer of #${o.id}`}
                  />
                )}
              </li>
            ))}
          </ul>
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
