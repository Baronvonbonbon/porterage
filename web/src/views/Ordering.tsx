// Placing an order and running its auction (docs/PLAN.md §4 steps 1–2).
//
// Everything here is signed by the order's own fresh account, so no tap is
// needed once it's funded — and nothing on-chain ties the order to the phone.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Wallet } from "ethers";
import { deployed } from "../contracts";
import { venueOf, type Venue } from "../order/venue";
import { formatDegrees, metresBetween, type Position } from "../order/geo";
import {
  acceptBid,
  cancelOrder,
  orderOf,
  statusName,
  type Order,
  pickupDeadline,
  reopenTimedOut,
} from "../order/orders";
import { orderTopic, watchBids, type Bid } from "../order/bids";
import { orderBurner, type PlaceStage } from "../order/flow";
import { allOrders, type OrderRecord } from "../shield/notes";
import {
  confirmDropoff,
  decodePayload,
  encodeDropRequest,
  makeDropRequest,
  type DropRequest,
} from "../order/handoff";
import { QrScan, QrShow } from "./QrLazy";

import { settleDebts } from "../order/flow";
import { progressOf } from "../order/progress";
import { Waiting } from "./State";
import { useConversation } from "./Tray";

import {
  committedPhotoKey,
  driverKeyFromDropSignature,
  fetchPhoto,
} from "../order/evidence";

import { menuOf, type Menu } from "../order/menu";

import { watchIntros } from "../order/chat";

import { sendDrop } from "../order/drop";
import { Directions } from "./Directions";
import { useHere } from "./Here";
import { disputeOf, fileDispute, type Filed } from "../order/dispute";
import { driverRating, rate, ratingText, wasRated } from "../order/ratings";
import { Stars } from "./pickers/Stars";
import { rememberOrder } from "../shield/notes";
import { tell } from "../notify";
import { errorText, metres, pasWei, short } from "../format";
import { DROP_SENDING, DROP_SENT, DROP_WAITING } from "../copy/privacy";
import { faceUrl, profileOf, watchFace, type Profile } from "../order/profile";
import { countdown } from "../format";

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
  const [mine, setMine] = useState<OrderRecord[]>([]);
  const [live, setLive] = useState<{
    record: OrderRecord;
    order: Order;
    burner: Wallet;
  } | null>(null);
  const [bids, setBids] = useState<Bid[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [door, setDoor] = useState<DropRequest | null>(null);
  const [scanning, setScanning] = useState(false);
  const [proveMs, setProveMs] = useState<number | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  // Who this order can talk to: the driver once it introduces itself, and the
  // kitchen whose key the menu published.
  const [driverKey, setDriverKey] = useState<string | null>(null);
  const [dropSent, setDropSent] = useState(false);
  const [liveMenu, setLiveMenu] = useState<Menu | null>(null);
  const [liveVenueAt, setLiveVenueAt] = useState<Position | null>(null);
  const [driverStars, setDriverStars] = useState(0);
  const [venueStars, setVenueStars] = useState(0);
  const [rated, setRated] = useState(false);
  const [complaint, setComplaint] = useState<string | null>(null);
  const [filed, setFiled] = useState<Filed | null>(null);
  /** Reputation, read on demand: venue id or driver address to its text. */
  const [stars, setStars] = useState<Map<string, string>>(new Map());
  /** The public half of each bidder's profile, by address. */
  const [faces, setFaces] = useState<Map<string, Profile | null>>(new Map());
  /** The assigned driver's photo, once they've sent the key to it. */
  const [theirFace, setTheirFace] = useState<string | null>(null);
  /** When the assigned driver has to have collected by; 0 when none. */
  const [dueBy, setDueBy] = useState(0);
  /** Ticks so the countdown counts down without a re-fetch. */
  const [now, setNow] = useState(() => Date.now());
  const [here, setHere] = useHere();
  /** Publish a coarse area with the order, so drivers can judge the trip. */
  /** What the customer is looking for, and what each venue says it is. */
  const stop = useRef<(() => void) | null>(null);
  /** Distinguishes "still looking" from "there are none", which look the same. */
  /** How each remembered order ended, so the list says more than a date. */
  const [past, setPast] = useState<Map<string, Order>>(new Map());

  const refresh = useCallback(async () => {
    setError(null);
    try {
      if (!deployed()) return;
      const records = await allOrders();
      setMine(records.sort((a, b) => b.placedAt - a.placedAt));
      // Read each one's state so the list can say how it ended. Cheap: these
      // are single reads, and there are as many as this device has placed.
      const states = await Promise.all(
        records.map(
          async (r) =>
            [r.id, await orderOf(BigInt(r.id), r.at).catch(() => null)] as const
        )
      );
      setPast(
        new Map(states.filter((row): row is [string, Order] => !!row[1]))
      );
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    return () => stop.current?.();
  }, [refresh]);

  /**
   * How far the delivery actually is: the venue's public pin to this phone's
   * own drop. Null until the venue's position has loaded.
   */
  const trip =
    liveVenueAt && live
      ? metresBetween(liveVenueAt, {
          lat: live.record.lat,
          lon: live.record.lon,
        })
      : null;

  // The pickup deadline, read when an order opens and again on assignment.
  useEffect(() => {
    if (!live || live.order.status !== 2) {
      setDueBy(0);
      return;
    }
    let on = true;
    pickupDeadline(BigInt(live.record.id), live.record.at)
      .then((at) => on && setDueBy(at))
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, [live]);

  // One tick a second while something is actually counting down. Without the
  // guard this would re-render the screen for ever on a finished order.
  useEffect(() => {
    if (!dueBy) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [dueBy]);

  const late = dueBy > 0 && now > dueBy * 1000;

  /** Run something that changes the order, with the busy line and the error. */
  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  // The driver's face arrives as a 32-byte key on the pair thread, not as a
  // photo: the photo went to Bulletin once, encrypted, and this is what makes
  // it readable — to this customer and nobody else (order/profile.ts).
  useEffect(() => {
    if (!live || !driverKey || live.order.status < 2) return;
    let on = true;
    let stop: (() => void) | null = null;
    watchFace(live.burner, driverKey, async (contentKey) => {
      const who = await profileOf(live.order.driver).catch(() => null);
      if (!who?.face || !on) return;
      const url = await faceUrl(who.face, contentKey);
      if (on && url) setTheirFace(url);
    })
      .then((s) => (stop = s))
      .catch(() => undefined);
    return () => {
      on = false;
      stop?.();
    };
  }, [live, driverKey]);

  // The customer's two conversations, handed to the tray for as long as the
  // order is in flight. Offered rather than rendered: see views/Tray.tsx.
  const inFlight = !!live && live.order.status >= 1 && live.order.status <= 3;
  useConversation(
    inFlight && driverKey
      ? {
          id: `${live!.record.id}:driver`,
          mine: live!.burner,
          theirs: driverKey,
          orderId: BigInt(live!.record.id),
          title: "The driver",
        }
      : null
  );
  useConversation(
    inFlight && liveMenu?.counterKey
      ? {
          id: `${live!.record.id}:kitchen`,
          mine: live!.burner,
          theirs: liveMenu.counterKey,
          orderId: BigInt(live!.record.id),
          title: liveMenu.name || "The kitchen",
        }
      : null
  );

  const openOrder = useCallback(async (record: OrderRecord) => {
    stop.current?.();
    setBids([]);
    const [order, burner] = await Promise.all([
      orderOf(BigInt(record.id), record.at),
      orderBurner(record),
    ]);
    // Anything the order still owes gets another go now that someone is here.
    const settled = await settleDebts(record, burner).catch(() => record);
    setLive({ record: settled, order, burner });
    stop.current = await watchBids(
      burner,
      BigInt(record.id),
      (bid) => {
        tell("bid", bid.bidHash);
        setBids((all) =>
          [...all.filter((b) => b.bidHash !== bid.bidHash), bid].sort((a, b) =>
            a.amount < b.amount ? -1 : 1
          )
        );
      },
      record.at
    );
  }, []);

  // Who is bidding, not just how well they are rated. The public half of a
  // profile is a Bulletin document keyed by content hash, so this is cached
  // after the first look (order/profile.ts).
  useEffect(() => {
    let on = true;
    Promise.all(
      bids.map(
        async (b) =>
          [b.driver.toLowerCase(), await profileOf(b.driver)] as const
      )
    )
      .then((rows) => on && setFaces(new Map(rows)))
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, [bids]);

  // And the reputation of whoever is bidding.
  useEffect(() => {
    let on = true;
    Promise.all(
      bids.map(
        async (b) =>
          [
            b.driver.toLowerCase(),
            ratingText(await driverRating(b.driver)),
          ] as const
      )
    )
      .then((rows) => on && setStars((m) => new Map([...m, ...rows])))
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, [bids]);

  // Say when the order moves, since the screen may not be in front of anyone.
  useEffect(() => {
    if (!live) return;
    const id = live.record.id;
    if (live.order.status === 3) tell("picked-up", id);
    if (live.order.status >= 4) tell("delivered", id);
  }, [live]);

  // The driver cannot deliver to a commitment. Once it has the job and has said
  // hello, it gets the exact drop — sealed to it alone, and to nobody else.
  // Automatic, because a driver in the street with no address is a failed
  // delivery; repeated, because replacing its own statement costs nothing and
  // covers a driver that missed it.
  useEffect(() => {
    if (!live || !driverKey) return;
    if (live.order.status < 2 || live.order.status > 3) return;
    let on = true;
    sendDrop(live.burner, driverKey, BigInt(live.record.id), {
      lat: live.record.lat,
      lon: live.record.lon,
    })
      .then(() => on && setDropSent(true))
      .catch(() => on && setDropSent(false));
    return () => {
      on = false;
    };
  }, [live, driverKey]);

  // Whether this order has already been rated or disputed: both are one-shot,
  // and the contract is the only place that knows.
  useEffect(() => {
    setRated(false);
    setFiled(null);
    setComplaint(null);
    if (!live) return;
    let on = true;
    const id = BigInt(live.record.id);
    wasRated(id)
      .then((r) => on && setRated(r))
      .catch(() => undefined);
    disputeOf(id)
      .then((d) => on && setFiled(d))
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, [live]);

  // A live order's own venue, which isn't the one the form is pointing at.
  useEffect(() => {
    setLiveMenu(null);
    setLiveVenueAt(null);
    if (!live) return;
    let on = true;
    venueOf(live.order.venueId)
      .then(async (v) => {
        if (on) setLiveVenueAt(v.at);
        return v.metadataURI ? menuOf(v.metadataURI) : null;
      })
      .then((m) => on && setLiveMenu(m))
      .catch(() => on && setLiveMenu(null));
    return () => {
      on = false;
    };
  }, [live]);

  // The driver introduces itself once it has the job; until then there is
  // nobody to message. After the door, its key is already on the record.
  useEffect(() => {
    setDriverKey(live?.record.driverKey ?? null);
    if (!live) return;
    let stopping: (() => void) | null = null;
    let on = true;
    watchIntros(live.burner, orderTopic(BigInt(live.record.id)), (intro) => {
      if (
        on &&
        intro.role === "driver" &&
        intro.orderId === BigInt(live.record.id)
      )
        setDriverKey(intro.publicKey);
    })
      .then((s) => (on ? (stopping = s) : s()))
      .catch(() => undefined);
    return () => {
      on = false;
      stopping?.();
    };
  }, [live]);

  async function take(bid: Bid) {
    if (!live) return;
    setBusy(`Accepting ${pasWei(bid.amount)}`);
    setError(null);
    try {
      await acceptBid(
        live.burner,
        BigInt(live.record.id),
        bid.driver,
        bid.amount,
        bid.salt,
        live.record.at
      );
      await openOrder(live.record);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function finish(text: string) {
    if (!live || !door) return;
    setScanning(false);
    setBusy("Proving the delivery on this phone");
    setError(null);
    try {
      const code = decodePayload(text);
      if (
        code.kind !== "dropSignature" ||
        code.orderId !== BigInt(live.record.id)
      ) {
        throw new Error("that code is for another order");
      }
      const driverKey = await driverKeyFromDropSignature(
        {
          orderId: BigInt(live.record.id),
          actor: live.order.driver,
          posCommit: door.payload.posCommit,
          timestamp: code.timestamp,
        },
        code.signature
      );
      await rememberOrder({ ...live.record, driverKey });
      const { proveMs: ms } = await confirmDropoff({
        burner: live.burner,
        orderId: BigInt(live.record.id),
        driver: live.order.driver,
        drop: { lat: live.record.lat, lon: live.record.lon },
        dropSalt: BigInt(live.record.salt),
        request: door,
        signature: code.signature,
        signedAt: code.timestamp,
      });
      setProveMs(ms);
      setDoor(null);
      await openOrder(live.record);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function sendRating() {
    if (!live) return;
    setBusy("Rating");
    setError(null);
    try {
      await rate(live.burner, BigInt(live.record.id), driverStars, venueStars);
      setRated(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  /**
   * File a dispute, enclosing the key to the driver's photo when there is one.
   * Only the arbiter can read either, and the photo's key opens that photo
   * alone — never the messages or any other photo.
   */
  async function fileComplaint() {
    if (!live || !complaint?.trim()) return;
    setBusy("Filing");
    setError(null);
    try {
      const id = BigInt(live.record.id);
      const photoKey = live.record.driverKey
        ? await committedPhotoKey(
            live.burner.signingKey,
            live.record.driverKey,
            id,
            live.order.driver
          ).catch(() => null)
        : null;
      await fileDispute(live.burner, id, {
        reason: complaint,
        photoKey: photoKey ?? undefined,
      });
      setFiled(await disputeOf(id));
      setComplaint(null);
      await openOrder(live.record);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  if (live && scanning) {
    return (
      <section>
        <h2>Scan the driver's code</h2>
        <QrScan
          expect="dropSignature"
          onCancel={() => setScanning(false)}
          onRead={finish}
        />
      </section>
    );
  }

  return (
    <section>
      {!live && (
        <>
          <h2>Your orders</h2>
          {mine.length === 0 && (
            <p className="muted">
              Nothing yet. Browse a place and put something in a bag.
            </p>
          )}
          {mine.length > 0 && (
            <ul>
              {mine.map((r) => {
                const was = past.get(r.id);
                return (
                  <li key={r.id}>
                    <button className="link" onClick={() => openOrder(r)}>
                      #{r.id} — {new Date(r.placedAt).toLocaleString()}
                    </button>
                    {was && (
                      <>
                        <br />
                        <span className="muted">
                          {progressOf(was, "customer").now}{" "}
                          {pasWei(was.orderValue + was.fare)}
                        </span>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {live && (
        <>
          {(() => {
            const p = progressOf(live.order, "customer");
            return (
              <p className={p.done ? "ok lead" : "lead"}>
                {p.now}
                {p.next && <span className="muted"> {p.next}</span>}
              </p>
            );
          })()}
          <dl>
            <dt>Order</dt>
            <dd>#{live.record.id}</dd>
            <dt>State</dt>
            <dd>{statusName(live.order.status)}</dd>
            <dt>From venue</dt>
            <dd>
              #{live.order.venueId.toString()}
              {liveVenueAt && (
                <>
                  {" "}
                  <Directions
                    at={liveVenueAt}
                    label={`Venue #${live.order.venueId}`}
                    what="the venue"
                  />
                </>
              )}
            </dd>
            <dt>Ordering account</dt>
            <dd title={live.burner.address}>{short(live.burner.address)}</dd>
            <dt>Drop</dt>
            <dd>
              {formatDegrees(live.record.lat)}, {formatDegrees(live.record.lon)}{" "}
              <span className="muted">(kept here)</span>
            </dd>
            {live.order.driver !==
              "0x0000000000000000000000000000000000000000" && (
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
              {/* The trip, stated once, above the bids rather than on each of
                  them: it is the same distance whoever takes the job, and
                  repeating it per row would imply it varied. This phone can
                  work it out without asking anyone — the venue's pin is
                  public and the drop is already here — so nobody has to
                  publish a position to make a bid comparable. */}
              {trip !== null && (
                <p className="muted">
                  {metres(trip)} from the counter to your door. A bid is what
                  that driver wants for the trip.
                </p>
              )}
              {bids.length === 0 && (
                <Waiting what="Waiting for drivers to bid" />
              )}
              <div className="actions">
                {bids.map((b) => {
                  const who = faces.get(b.driver.toLowerCase());
                  return (
                    <button
                      key={b.bidHash}
                      disabled={!!busy || !b.standing}
                      onClick={() => take(b)}
                    >
                      {pasWei(b.amount)}
                      <br />
                      {/* A name and a vehicle where an address used to be.
                          Both are chosen by the driver and neither is
                          verified — which is what the rating is for. */}
                      {who?.name ?? short(b.driver)} ·{" "}
                      {stars.get(b.driver.toLowerCase()) ?? "…"}
                      {who?.vehicle && ` · ${who.vehicle}`}
                      {b.standing ? "" : " (withdrawn)"}
                    </button>
                  );
                })}
              </div>
              <button
                className="danger"
                disabled={!!busy}
                onClick={() =>
                  cancelOrder(live.burner, BigInt(live.record.id), live.record.at)
                    .then(() => openOrder(live.record))
                    .catch((e) => setError(errorText(e)))
                }
              >
                Cancel this order
              </button>
            </>
          )}

          {live.order.status === 2 && (
            <>
              {/* Who is actually coming. Shown only here, only once they
                  have the job, and only to this customer. */}
              {(theirFace || faces.get(live.order.driver.toLowerCase())) && (
                <div className="who">
                  {theirFace && (
                    <img className="who-face" src={theirFace} alt="" />
                  )}
                  <span>
                    <b>
                      {faces.get(live.order.driver.toLowerCase())?.name ??
                        short(live.order.driver)}
                    </b>{" "}
                    is bringing it
                    {faces.get(live.order.driver.toLowerCase())?.vehicle && (
                      <>
                        <br />
                        <span className="muted">
                          {faces.get(live.order.driver.toLowerCase())!.vehicle}
                        </span>
                      </>
                    )}
                  </span>
                </div>
              )}
              <p className="muted">
                Assigned. The driver collects it from the counter next.{" "}
                {dropSent ? DROP_SENT : driverKey ? DROP_SENDING : DROP_WAITING}
              </p>
              {dueBy > 0 && !late && (
                <p className="muted">
                  They have {countdown(dueBy * 1000 - now)} to collect it. After
                  that you can take the job off them without losing the order.
                </p>
              )}
              {late && (
                <div className="notice">
                  <p>
                    <b>They haven't collected it.</b> You can hand the job to
                    somebody else: the order stays where it is, the venue keeps
                    making it, and bids come in again. Your fare comes back —
                    the next driver's bid sets its own — and this one takes a
                    strike on their record.
                  </p>
                  <button
                    className="primary"
                    disabled={!!busy}
                    onClick={() =>
                      run("Finding another driver", async () => {
                        await reopenTimedOut(
                          live.burner,
                          BigInt(live.record.id),
                          live.record.at
                        );
                        await openOrder(live.record);
                      })
                    }
                  >
                    Find another driver
                  </button>
                </div>
              )}
            </>
          )}

          {live.order.status === 3 && (
            <>
              <h3>At the door</h3>
              {!door && (
                <div className="actions">
                  <button
                    onClick={() =>
                      setDoor(
                        makeDropRequest(BigInt(live.record.id), {
                          lat: live.record.lat,
                          lon: live.record.lon,
                        })
                      )
                    }
                  >
                    Show the driver a code
                  </button>
                </div>
              )}
              {door && (
                <>
                  <QrShow
                    value={encodeDropRequest(door.payload)}
                    caption="The driver scans this and signs it. It carries no address — only a commitment to where you are."
                  />
                  <div className="actions">
                    <button disabled={!!busy} onClick={() => setScanning(true)}>
                      Scan the driver's code back
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {live.order.status >= 1 && live.order.status <= 3 && (
            <>
              {/* Both conversations go to the tray at the bottom of the screen
                  rather than being stacked in the middle of it, where a long
                  one pushed the order's own controls off the page. */}
              {(driverKey || liveMenu?.counterKey) && (
                <p className="muted">
                  {driverKey && liveMenu?.counterKey
                    ? "The driver and the kitchen are both in Messages, below."
                    : "In Messages, below."}
                </p>
              )}
              {!driverKey && live.order.status >= 2 && (
                <p className="muted">
                  The driver can be messaged once it says hello — it does that
                  itself when it picks up the job.
                </p>
              )}
            </>
          )}

          {filed && (
            <p className="notice">
              Dispute #{filed.disputeId.toString()} is{" "}
              {filed.status === 2 ? "settled" : "open"}. The escrow is held
              until an arbiter rules on it.
            </p>
          )}

          {!filed && live.order.status >= 2 && live.order.status <= 3 && (
            <>
              {complaint === null ? (
                <button
                  className="link"
                  disabled={!!busy}
                  onClick={() => setComplaint("")}
                >
                  Something's wrong with this order
                </button>
              ) : (
                <div className="actions">
                  <label>
                    What happened{" "}
                    <input
                      value={complaint}
                      maxLength={200}
                      onChange={(e) => setComplaint(e.target.value)}
                      placeholder="It never arrived"
                    />
                  </label>
                  <p className="muted">
                    This freezes the money until an arbiter rules. Only the
                    arbiter can read what you write, and the photo's key goes
                    with it — that key opens this photo and nothing else.
                  </p>
                  <button
                    className="primary"
                    disabled={!!busy || !complaint.trim()}
                    onClick={fileComplaint}
                  >
                    File it
                  </button>
                  <button
                    className="link"
                    disabled={!!busy}
                    onClick={() => setComplaint(null)}
                  >
                    Never mind
                  </button>
                </div>
              )}
            </>
          )}

          {live.order.status >= 4 && (
            <>
              <p className="ok">
                Delivered and paid.
                {proveMs !== null &&
                  ` The proof took ${(proveMs / 1000).toFixed(
                    1
                  )} s on this phone.`}
              </p>
              {live.record.driverKey && !photo && (
                <button
                  className="link"
                  disabled={!!busy}
                  onClick={() =>
                    fetchPhoto(
                      live.burner.signingKey,
                      live.record.driverKey!,
                      BigInt(live.record.id),
                      live.order.driver
                    )
                      .then((p) => setPhoto(p ?? null))
                      .catch((e) => setError(errorText(e)))
                  }
                >
                  See the driver's photo
                </button>
              )}
              {photo && (
                <img className="evidence" src={photo} alt="the delivery" />
              )}

              {rated ? (
                <p className="muted">
                  Rated. Thanks — it's counted against the driver's address, not
                  against you.
                </p>
              ) : (
                <div className="actions">
                  <Stars
                    label="The driver"
                    value={driverStars}
                    onPick={setDriverStars}
                  />
                  <Stars
                    label="The venue"
                    value={venueStars}
                    onPick={setVenueStars}
                  />
                  <button
                    className="primary"
                    disabled={!!busy || (!driverStars && !venueStars)}
                    onClick={sendRating}
                  >
                    Rate this order
                  </button>
                  <p className="muted">
                    Sent from this order's own account, so it says what the
                    order was like and nothing about you. One rating per order,
                    and it can't be changed.
                  </p>
                </div>
              )}
            </>
          )}

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
