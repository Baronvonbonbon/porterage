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
import { read } from "../contracts";
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
import { record as recordEntry } from "../books/ledger";
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
import { keyBytes, sendFace } from "../order/profile";
import { myFaceKey } from "./driver/Profile";

export function Jobs({
  sessionKey,
  driver,
  show,
}: {
  sessionKey: Wallet;
  driver: string;
  /**
   * Which half to draw. Both used to be on one page, under the onboarding and
   * the earnings and the funding helper — so a driver looking for work read
   * past four other things first, and a driver mid-delivery read past the job
   * list to find the delivery. One screen answers one question.
   *
   * The data behind both is loaded either way: the venues, the saved pin and
   * the coarse areas are shared, and a driver switching tabs should not wait
   * for a reload.
   */
  show: "work" | "mine";
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
  /** Orders this driver has bid on and not yet heard about. */
  const bidOn = useRef<Set<string>>(new Set());
  /**
   * The protocol's cut, read from the contract rather than assumed. It is
   * governance-settable, so a hardcoded 250 would quietly make every driver's
   * income record wrong the day it changed.
   */
  const feeBps = useRef(250n);
  /** Recent bids that went to somebody else, so the list can say so. */
  const [lost, setLost] = useState<string[]>([]);

  /** Drops the customers have sent for the jobs this driver holds. */
  const [drops, setDrops] = useState<Map<string, Position>>(new Map());

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const all = await recentOrders();
      const stillOpen = all.filter((o) => o.status === Status.Open);

      // An order this driver bid on that is no longer open went to somebody
      // else. Before this, a bid simply stopped existing: the row vanished
      // from the list and nothing said why, which reads like a bug and makes
      // a driver wonder whether bidding works at all.
      for (const id of bidOn.current) {
        const order = all.find((o) => o.id.toString() === id);
        if (!order || order.status === Status.Open) continue;
        const won = order.driver.toLowerCase() === driver.toLowerCase();
        bidOn.current.delete(id);
        if (!won) setLost((l) => [...l, id].slice(-3));
      }

      setOpen(stillOpen);
      const yours = all.filter(
        (o) =>
          o.driver.toLowerCase() === driver.toLowerCase() &&
          o.status >= Status.Assigned
      );
      setMine(yours);
      // A driver never sees the settlement land -- the customer submits it --
      // so the only moment this device learns a job paid is when its status
      // comes back Delivered. Writing the row here is what gives a driver an
      // income record at all; the vault only ever shows a running balance.
      // `record` replaces by order id, so re-seeing a delivered job is free.
      for (const o of yours) {
        if (o.status < Status.Delivered) continue;
        const fee = (o.fare * feeBps.current) / 10_000n;
        recordEntry({
          kind: "earning",
          orderId: o.id.toString(),
          at: Date.now(),
          venueId: o.venueId.toString(),
          fare: o.fare.toString(),
          tip: o.tip.toString(),
          fee: fee.toString(),
          net: (o.fare - fee + o.tip).toString(),
        }).catch(() => undefined);
      }
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
        // The key to this driver's face, to the one customer that picked
        // them. 32 bytes sealed on the pair thread — so it costs a statement
        // and no tap, however many jobs a driver takes. The photo itself went
        // to Bulletin once, encrypted (order/profile.ts).
        const mine = myFaceKey();
        if (mine)
          await sendFace(sessionKey, key, keyBytes(mine)).catch(
            () => undefined
          );
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
    read("orders")
      .feeBps()
      .then((b: bigint) => (feeBps.current = BigInt(b)))
      .catch(() => undefined);
  }, []);

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
      {show === "work" && (
        <>
          <h3>Work</h3>
          <p className="muted">Your rating: {rating}</p>
          {/* A bid that loses used to just stop existing — the row vanished
              and nothing said why, which reads like a bug. */}
          {lost.length > 0 && (
            <p className="muted">
              {lost.length === 1
                ? `#${lost[0]} went to another driver.`
                : `${lost
                    .map((i) => `#${i}`)
                    .join(", ")} went to other drivers.`}{" "}
              <button className="link" onClick={() => setLost([])}>
                dismiss
              </button>
            </p>
          )}
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
              <div key={o.id.toString()} className="job">
                {/* What a driver decides on, in the order they decide it: how
                    much, how far to the counter, how far after that. The
                    order number comes last — it identifies the job and sells
                    it to nobody. */}
                <p className="lead">
                  up to {pasWei(o.maxFare)}
                  {pickup !== null && (
                    <span className="muted">
                      {" "}
                      · {far(pickup)} to the counter
                    </span>
                  )}
                  {trip !== null && (
                    <span className="muted"> · {far(trip)} on from there</span>
                  )}
                </p>
                <p className="muted">
                  #{o.id.toString()} from venue #{o.venueId.toString()}
                  {pickup === null &&
                    v &&
                    ` at ${formatDegrees(v.at.lat)}, ${formatDegrees(
                      v.at.lon
                    )}`}
                  , carrying {pasWei(o.orderValue)} of goods.
                  {trip === null &&
                    " The drop isn't said — you'll learn it once the job is yours."}
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
        </>
      )}

      {show === "mine" && mine.length === 0 && (
        <p className="muted">
          Nothing on the go. Bid for something on <b>Work</b>.
        </p>
      )}

      {show === "mine" && mine.length > 0 && (
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
