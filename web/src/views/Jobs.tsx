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
import { Amount } from "./pickers";
import { pasOrNull } from "../money/amount";
import { progressOf } from "../order/progress";
import { introduce } from "../order/chat";
import { fileDisputeAsDriver } from "../order/dispute";
import { driverRating, ratingText } from "../order/ratings";
import { Camera } from "./Camera";
import { commitPhoto } from "../order/evidence";
import {
  forgetPickupPhoto,
  pickupPhoto,
  rememberPickupPhoto,
} from "../shield/notes";
import { formatDegrees, metresBetween, type Position } from "../order/geo";
import { watchAreas } from "../order/area";
import { watchDrop } from "../order/drop";
import { Directions } from "./Directions";
import { knownDrops, rememberDrop } from "../shield/notes";
import { HerePin, useHere } from "./Here";
import { tell } from "../notify";
import { errorText, metres, pasWei } from "../format";
import { photoSealed } from "../copy/privacy";

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
  const [photoFor, setPhotoFor] = useState<{
    order: Order;
    where: "counter" | "door";
  } | null>(null);
  /** Order id to the customer's key, once we've said hello on that order. */
  const [talking, setTalking] = useState<Map<string, string>>(new Map());
  const [talkTo, setTalkTo] = useState<Order | null>(null);
  const greeted = useRef(new Set<string>());
  const [rating, setRating] = useState<string>("…");
  const [complaint, setComplaint] = useState<{
    order: Order;
    text: string;
  } | null>(null);
  const [here, setHere] = useHere();
  /** Coarse drop areas, for the orders whose customers chose to publish one. */
  const [areas, setAreas] = useState<Map<string, Position>>(new Map());
  /** Drops the customers have sent for the jobs this driver holds. */
  const [drops, setDrops] = useState<Map<string, Position>>(new Map());

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

  // Customers may publish a coarse area with an order. Most won't, and those
  // orders show nothing rather than a guess.
  useEffect(() => {
    if (!open.length) return;
    let stop: (() => void) | null = null;
    let gone = false;
    watchAreas(
      open.map((o) => o.id),
      (orderId, cell) =>
        setAreas((all) => new Map(all).set(orderId.toString(), cell))
    )
      .then((s) => (gone ? s() : (stop = s)))
      .catch(() => undefined);
    return () => {
      gone = true;
      stop?.();
    };
  }, [open]);

  useEffect(() => {
    knownDrops().then((stored) =>
      setDrops(
        new Map(Object.entries(stored).map(([id, at]) => [id, at as Position]))
      )
    );
  }, []);

  // The customer sends the exact drop once this driver has the job. It arrives
  // sealed to this device's session key, and is kept, because the statement it
  // came in expires and an address that vanished mid-delivery would be worse
  // than one that never came.
  useEffect(() => {
    const stops: (() => void)[] = [];
    let gone = false;
    for (const o of mine) {
      const customerKey = talking.get(o.id.toString());
      if (!customerKey || o.status >= Status.Delivered) continue;
      watchDrop(sessionKey, customerKey, o.id, (at) => {
        setDrops((all) => new Map(all).set(o.id.toString(), at));
        rememberDrop(o.id, at).catch(() => undefined);
      })
        .then((stop) => (gone ? stop() : stops.push(stop)))
        .catch(() => undefined);
    }
    return () => {
      gone = true;
      for (const stop of stops) stop();
    };
  }, [mine, talking, sessionKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function bid(o: Order) {
    // The field has already said what is wrong with it; this is the guard, not
    // the message.
    const amount = pasOrNull(amounts.get(o.id.toString()) ?? "", {
      max: o.maxFare,
    });
    if (amount === null) return;
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
      // The counter photo, offered right after the handover while the goods
      // are still in front of the driver. It is kept on this phone and
      // committed at the door with the delivery photo, because the contract
      // allows one evidence commitment per order (order/evidence.ts).
      setPhotoFor({ order: o, where: "counter" });
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
      setPhotoFor({ order: o, where: "door" });
      setNote(
        "Show this back to the customer. You signed their code without learning the address."
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function photographed(
    o: Order,
    where: "counter" | "door",
    jpeg: Uint8Array
  ) {
    setPhotoFor(null);
    // The counter photo goes nowhere yet: it waits in the encrypted book for
    // the door photo, and the two are committed together under the single
    // evidence key the contract allows.
    if (where === "counter") {
      await rememberPickupPhoto(o.id, jpeg).catch(() => undefined);
      setNote(
        "Photo of the collection kept on this phone. It's sent with the " +
          "delivery photo at the door."
      );
      return;
    }

    setBusy("Storing the photo");
    setError(null);
    try {
      const key = await customerKeyOf(o.id);
      if (!key) throw new Error("this order's account hasn't published a key");
      const earlier = await pickupPhoto(o.id).catch(() => null);
      const { bytes } = await commitPhoto(
        sessionKey,
        o.id,
        key,
        earlier ? [earlier, jpeg] : [jpeg]
      );
      await forgetPickupPhoto(o.id).catch(() => undefined);
      setNote(photoSealed(bytes));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  if (photoFor) {
    const atCounter = photoFor.where === "counter";
    return (
      <div>
        <h3>
          {atCounter
            ? "Photograph what you collected"
            : "Photograph the delivery"}
        </h3>
        <p className="muted">
          {atCounter
            ? "Optional, and worth it if what you're carrying is easy to argue about later. It stays on this phone until the door, then goes with the delivery photo under one key."
            : "Only you and this customer can open it. Its key goes on-chain now, before the order settles, so it counts as evidence if anything is disputed later."}
        </p>
        <Camera
          onCancel={() => setPhotoFor(null)}
          onTaken={(jpeg) => photographed(photoFor.order, photoFor.where, jpeg)}
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

  /** How far the pickup is, and the trip when the customer said. */
  const jobs = open
    .map((o) => {
      const venue = venues.get(o.venueId.toString());
      const area = areas.get(o.id.toString());
      const pickup =
        here && venue
          ? metresBetween({ lat: here.lat, lon: here.lon }, venue.at)
          : null;
      return {
        order: o,
        venue,
        area,
        pickup,
        trip: venue && area ? metresBetween(venue.at, area) : null,
      };
    })
    .filter((j) => !here || (j.pickup !== null && j.pickup <= here.metres))
    .sort((a, b) => (a.pickup ?? 0) - (b.pickup ?? 0));

  const far = metres;

  return (
    <div>
      <h3>Work</h3>
      <p className="muted">Your rating: {rating}</p>
      <HerePin
        here={here}
        onChange={setHere}
        start={venues.values().next().value?.at ?? { lat: 0, lon: 0 }}
        what="jobs"
      />
      {open.length === 0 && (
        <p className="muted">No orders are open right now.</p>
      )}
      {open.length > 0 && jobs.length === 0 && (
        <p className="muted">
          Nothing within {((here?.metres ?? 0) / 1000).toFixed(1)} km —{" "}
          {open.length} open further out.
        </p>
      )}
      {jobs.map(({ order: o, venue: v, pickup, trip }) => {
        return (
          <div key={o.id.toString()} className="actions">
            <p>
              <b>#{o.id.toString()}</b> — collect from venue #
              {o.venueId.toString()}
              {pickup !== null
                ? `, ${far(pickup)} from you`
                : v &&
                  ` at ${formatDegrees(v.at.lat)}, ${formatDegrees(v.at.lon)}`}
              , goods {pasWei(o.orderValue)}, pays up to {pasWei(o.maxFare)}
              <br />
              <span className="muted">
                {trip !== null
                  ? `drop: about ${far(trip)} from the venue`
                  : "drop: not said — you'll learn it at the door"}
              </span>
              {v && (
                <>
                  {" "}
                  <Directions
                    at={v.at}
                    label={`Venue #${o.venueId}`}
                    what="the counter"
                  />
                </>
              )}
            </p>
            <Amount
              label="Bid"
              value={amounts.get(o.id.toString()) ?? ""}
              onChange={(text) =>
                setAmounts(new Map(amounts).set(o.id.toString(), text))
              }
              max={o.maxFare}
              hint={`Up to ${pasWei(
                o.maxFare
              )}. The customer sees your bid privately and may take any of them.`}
            />
            <button
              className="primary"
              disabled={
                !!busy ||
                pasOrNull(amounts.get(o.id.toString()) ?? "", {
                  max: o.maxFare,
                }) === null
              }
              onClick={() => bid(o)}
            >
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
                <br />
                <span className="muted">
                  {progressOf(o, "driver").next ?? progressOf(o, "driver").now}
                </span>
                {o.status < Status.Delivered && (
                  <>
                    <br />
                    {drops.get(o.id.toString()) ? (
                      <span>
                        deliver to{" "}
                        {formatDegrees(drops.get(o.id.toString())!.lat)},{" "}
                        {formatDegrees(drops.get(o.id.toString())!.lon)}
                        {venues.get(o.venueId.toString()) &&
                          ` — ${far(
                            metresBetween(
                              venues.get(o.venueId.toString())!.at,
                              drops.get(o.id.toString())!
                            )
                          )} from the counter`}{" "}
                        <Directions
                          at={drops.get(o.id.toString())!}
                          label={`Order #${o.id}`}
                          what="the drop"
                        />
                      </span>
                    ) : (
                      <span className="muted">
                        waiting for the address — the customer's app sends it
                        once you've said hello
                      </span>
                    )}
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
                      className="primary"
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
