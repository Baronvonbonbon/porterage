// Placing an order and running its auction (docs/PLAN.md §4 steps 1–2).
//
// Everything here is signed by the order's own fresh account, so no tap is
// needed once it's funded — and nothing on-chain ties the order to the phone.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Wallet } from "ethers";
import { deployed } from "../contracts";
import { allVenues, venueOf, type Venue } from "../order/venue";
import {
  formatDegrees,
  metresBetween,
  parseDegrees,
  type Position,
} from "../order/geo";
import {
  acceptBid,
  cancelOrder,
  orderOf,
  statusName,
  type Order,
} from "../order/orders";
import { orderTopic, watchBids, type Bid } from "../order/bids";
import {
  fundingFor,
  orderBurner,
  placeOrder,
  type PlaceStage,
} from "../order/flow";
import { allOrders, type OrderRecord } from "../shield/notes";
import {
  confirmDropoff,
  decodePayload,
  encodeDropRequest,
  makeDropRequest,
  type DropRequest,
} from "../order/handoff";
import { QrScan, QrShow } from "./Qr";
import { Choose, ChooseMany } from "./pickers/Choose";
import { Amount, Count } from "./pickers";
import { pasOrNull } from "../money/amount";
import { settleDebts } from "../order/flow";
import { progressOf } from "../order/progress";
import { Waiting } from "./State";
import { Thread } from "./Thread";
import { MapPick } from "./pickers/MapPick";
import {
  committedPhotoKey,
  driverKeyFromDropSignature,
  fetchPhoto,
} from "../order/evidence";
import { PHASE_DROPOFF } from "../order/handoff";
import { basketTotal, basketText, menuOf, type Menu } from "../order/menu";
import { LABELS, labelWord, matchesLabels, type Label } from "../order/labels";
import { watchIntros } from "../order/chat";
import { cellOf, cellVagueness, publishArea } from "../order/area";
import { sendDrop } from "../order/drop";
import { Directions } from "./Directions";
import { HerePin, useHere } from "./Here";
import { disputeOf, fileDispute, type Filed } from "../order/dispute";
import {
  driverRating,
  rate,
  ratingText,
  venueRating,
  wasRated,
} from "../order/ratings";
import { Stars } from "./pickers/Stars";
import { rememberOrder } from "../shield/notes";
import { tell } from "../notify";
import { errorText, metres, pasWei, short } from "../format";
import {
  BASKET_SEALED,
  BASKET_UNSEALED,
  coarseArea,
  DROP_SENDING,
  DROP_SENT,
  DROP_WAITING,
} from "../copy/privacy";

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
  const [live, setLive] = useState<{
    record: OrderRecord;
    order: Order;
    burner: Wallet;
  } | null>(null);
  const [bids, setBids] = useState<Bid[]>([]);
  const [stage, setStage] = useState<PlaceStage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [door, setDoor] = useState<DropRequest | null>(null);
  const [scanning, setScanning] = useState(false);
  const [proveMs, setProveMs] = useState<number | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [picked, setPicked] = useState<Map<string, number>>(new Map());
  const [photo, setPhoto] = useState<string | null>(null);
  const [mapping, setMapping] = useState(false);
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
  const [here, setHere] = useHere();
  /** Publish a coarse area with the order, so drivers can judge the trip. */
  const [tellArea, setTellArea] = useState(false);
  /** What the customer is looking for, and what each venue says it is. */
  const [wanted, setWanted] = useState<Label[]>([]);
  const [venueLabels, setVenueLabels] = useState<Map<string, Label[]>>(
    new Map()
  );
  const stop = useRef<(() => void) | null>(null);
  /** Distinguishes "still looking" from "there are none", which look the same. */
  const [loadingVenues, setLoadingVenues] = useState(true);
  /** How each remembered order ended, so the list says more than a date. */
  const [past, setPast] = useState<Map<string, Order>>(new Map());

  const refresh = useCallback(async () => {
    setError(null);
    try {
      if (!deployed()) return;
      setVenues((await allVenues()).filter((v) => v.active));
      const records = await allOrders();
      setMine(records.sort((a, b) => b.placedAt - a.placedAt));
      // Read each one's state so the list can say how it ended. Cheap: these
      // are single reads, and there are as many as this device has placed.
      const states = await Promise.all(
        records.map(
          async (r) =>
            [r.id, await orderOf(BigInt(r.id)).catch(() => null)] as const
        )
      );
      setPast(
        new Map(states.filter((row): row is [string, Order] => !!row[1]))
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      // In the finally, or a load that failed would spin for ever.
      setLoadingVenues(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    return () => stop.current?.();
  }, [refresh]);

  const openOrder = useCallback(async (record: OrderRecord) => {
    stop.current?.();
    setBids([]);
    const [order, burner] = await Promise.all([
      orderOf(BigInt(record.id)),
      orderBurner(record),
    ]);
    // Anything the order still owes gets another go now that someone is here.
    const settled = await settleDebts(record, burner).catch(() => record);
    setLive({ record: settled, order, burner });
    stop.current = await watchBids(burner, BigInt(record.id), (bid) => {
      tell("bid", bid.bidHash);
      setBids((all) =>
        [...all.filter((b) => b.bidHash !== bid.bidHash), bid].sort((a, b) =>
          a.amount < b.amount ? -1 : 1
        )
      );
    });
  }, []);

  // The venue's menu lives on Bulletin; its pointer is the venue's metadata.
  useEffect(() => {
    setMenu(null);
    setPicked(new Map());
    const v = venues.find((x) => x.id.toString() === venueId);
    if (!v?.metadataURI) return;
    let live = true;
    menuOf(v.metadataURI)
      .then((m) => live && setMenu(m))
      .catch(() => live && setMenu(null));
    return () => {
      live = false;
    };
  }, [venueId, venues]);

  // Every venue's labels, which live in its menu. The first pass costs a
  // Bulletin fetch each; after that the cache answers (order/menu.ts).
  useEffect(() => {
    let on = true;
    Promise.all(
      venues.map(async (v) => {
        const m = v.metadataURI
          ? await menuOf(v.metadataURI).catch(() => null)
          : null;
        return [v.id.toString(), m?.labels ?? []] as const;
      })
    )
      .then((rows) => on && setVenueLabels(new Map(rows)))
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, [venues]);

  // Venue reputations, so a venue can be chosen on more than its distance.
  useEffect(() => {
    let on = true;
    Promise.all(
      venues.map(
        async (v) =>
          [v.id.toString(), ratingText(await venueRating(v.id))] as const
      )
    )
      .then((rows) => on && setStars((m) => new Map([...m, ...rows])))
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, [venues]);

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

  const drop = { lat: parseDegrees(lat), lon: parseDegrees(lon) };
  const basket = menu ? basketTotal(menu, picked) : null;
  // The amounts are parsed once, here, and the button is off until both read.
  // The inline `Number(x) * 1e6` this replaces turned "one" into a thrown NaN
  // and quietly rounded away anything past six decimals.
  const goodsWei = basket !== null && basket > 0n ? basket : pasOrNull(goods);
  const maxFareWei = pasOrNull(maxFare);
  const plan =
    venueId &&
    drop.lat !== null &&
    drop.lon !== null &&
    goodsWei !== null &&
    maxFareWei !== null
      ? {
          venueId: BigInt(venueId),
          drop: { lat: drop.lat, lon: drop.lon },
          orderValue: goodsWei,
          basket: menu
            ? { items: picked, counterKey: menu.counterKey }
            : undefined,
          tip: 0n,
          maxFare: maxFareWei,
        }
      : null;

  async function place() {
    if (!plan) return;
    setError(null);
    try {
      const { record } = await placeOrder(plan, setStage);
      if (tellArea) {
        // After the order exists, and never as part of placing it: a failed
        // area must not lose an order that already went through.
        await publishArea(BigInt(record.id), plan.drop).catch(() => undefined);
      }
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
      await acceptBid(
        live.burner,
        BigInt(live.record.id),
        bid.driver,
        bid.amount,
        bid.salt
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

  /** Distance from the saved pin, nearest first, and only what's in range. */
  const near = (() => {
    const rows = venues.map((v) => ({
      ...v,
      away: here ? metresBetween({ lat: here.lat, lon: here.lon }, v.at) : null,
    }));
    const wantedOnly = rows.filter((v) =>
      matchesLabels(venueLabels.get(v.id.toString()) ?? [], wanted)
    );
    if (!here) return wantedOnly;
    return wantedOnly
      .filter((v) => v.away !== null && v.away <= here.metres)
      .sort((a, b) => (a.away ?? 0) - (b.away ?? 0));
  })();

  const fromHere = (away: number) => `${metres(away)} away`;

  const chosenVenue = venues.find((v) => v.id.toString() === venueId);

  if (mapping && chosenVenue) {
    return (
      <section>
        <h2>Where to</h2>
        <MapPick
          venue={chosenVenue.at}
          initial={
            drop.lat !== null && drop.lon !== null
              ? { lat: drop.lat, lon: drop.lon }
              : undefined
          }
          onCancel={() => setMapping(false)}
          onPick={(p) => {
            setLat(formatDegrees(p.lat));
            setLon(formatDegrees(p.lon));
            setMapping(false);
          }}
        />
      </section>
    );
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
      <h2>Order</h2>

      {!live && (
        <>
          {near.length === 0 && venues.length > 0 ? (
            <p className="notice">
              No venues within {((here?.metres ?? 0) / 1000).toFixed(1)} km.{" "}
              <button className="link" onClick={() => setHere(null)}>
                Show them all
              </button>
            </p>
          ) : null}
          {venues.length === 0 ? (
            loadingVenues ? (
              <Waiting what="Looking for venues" />
            ) : (
              <p className="notice">
                No venues have registered yet. Open Sell on another phone to add
                one.
              </p>
            )
          ) : (
            <div className="actions">
              <HerePin
                here={here}
                onChange={setHere}
                start={venues[0].at}
                what="venues"
              />
              <p className="muted">Looking for</p>
              <ChooseMany
                label="What are you looking for"
                values={wanted}
                onPick={setWanted}
                choices={LABELS.map((l) => ({ value: l, label: labelWord(l) }))}
              />
              <p className="muted">From</p>
              <Choose
                label="Venue"
                value={venueId}
                onPick={setVenueId}
                choices={near.map((v) => ({
                  value: v.id.toString(),
                  label: `#${v.id.toString()}`,
                  note: [
                    (venueLabels.get(v.id.toString()) ?? [])
                      .map(labelWord)
                      .join(", "),
                    stars.get(v.id.toString()) ?? "…",
                    v.away === null ? "" : fromHere(v.away),
                  ]
                    .filter(Boolean)
                    .join(" — "),
                }))}
              />
              {menu ? (
                <>
                  <p>
                    <b>{menu.name || `Venue #${venueId}`}</b>
                  </p>
                  {menu.items.map((i) => (
                    <p key={i.id} className="line">
                      <Count
                        label={i.name}
                        value={picked.get(i.id) ?? 0}
                        onChange={(n) =>
                          setPicked(new Map(picked).set(i.id, n))
                        }
                      />{" "}
                      {i.name} — {pasWei(i.price)}
                    </p>
                  ))}
                  <p className="muted">
                    {basket && basket > 0n
                      ? `${basketText(menu, picked)} — ${pasWei(basket)}`
                      : "Pick something from the menu."}
                    {menu.counterKey
                      ? ` ${BASKET_SEALED}`
                      : ` ${BASKET_UNSEALED}`}
                  </p>
                </>
              ) : (
                <Amount
                  label="Goods worth"
                  value={goods}
                  onChange={setGoods}
                  presets={[1, 5, 10]}
                  hint={
                    venueId ? "This venue has published no menu." : undefined
                  }
                />
              )}
              <Amount
                label="Pay up to"
                value={maxFare}
                onChange={setMaxFare}
                presets={[1, 2, 5]}
                hint="The most the delivery may cost. Drivers bid under it."
              />
              <label>
                Drop at{" "}
                <input
                  inputMode="decimal"
                  value={lat}
                  onChange={(e) => setLat(e.target.value)}
                  size={11}
                />
                <input
                  inputMode="decimal"
                  value={lon}
                  onChange={(e) => setLon(e.target.value)}
                  size={11}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={tellArea}
                  onChange={(e) => setTellArea(e.target.checked)}
                />{" "}
                Let drivers see roughly where this goes
              </label>
              {tellArea && drop.lat !== null && drop.lon !== null && (
                <p className="warn">
                  {coarseArea(
                    `${formatDegrees(
                      cellOf({ lat: drop.lat, lon: drop.lon }).lat
                    )}, ${formatDegrees(
                      cellOf({ lat: drop.lat, lon: drop.lon }).lon
                    )}`,
                    cellVagueness(drop.lat)
                  )}
                </p>
              )}
              <button
                className="link"
                disabled={!chosenVenue}
                onClick={() => setMapping(true)}
              >
                {chosenVenue
                  ? "Choose it on a map"
                  : "Choose a venue to use the map"}
              </button>
              {plan && (
                <p className="muted">
                  Needs {pasWei(fundingFor(plan))} in one note: the goods, the
                  fare and its own gas. The drop stays on this phone — the order
                  carries only a commitment to it.
                </p>
              )}
              <button
                className="primary"
                disabled={!plan || !!stage}
                onClick={place}
              >
                Place the order
              </button>
            </div>
          )}
          {stage && <p className="muted">{STAGE_TEXT[stage]}…</p>}

          {mine.length > 0 && (
            <>
              <h3>Your orders</h3>
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
            </>
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
              {bids.length === 0 && (
                <Waiting what="Waiting for drivers to bid" />
              )}
              <div className="actions">
                {bids.map((b) => (
                  <button
                    key={b.bidHash}
                    disabled={!!busy || !b.standing}
                    onClick={() => take(b)}
                  >
                    {pasWei(b.amount)} — {short(b.driver)},{" "}
                    {stars.get(b.driver.toLowerCase()) ?? "…"}
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

          {live.order.status === 2 && (
            <p className="muted">
              Assigned. The driver collects it from the counter next.{" "}
              {dropSent ? DROP_SENT : driverKey ? DROP_SENDING : DROP_WAITING}
            </p>
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
              {driverKey && (
                <Thread
                  mine={live.burner}
                  theirs={driverKey}
                  orderId={BigInt(live.record.id)}
                  title="You and the driver"
                />
              )}
              {liveMenu?.counterKey && (
                <Thread
                  mine={live.burner}
                  theirs={liveMenu.counterKey}
                  orderId={BigInt(live.record.id)}
                  title={`You and ${liveMenu.name || "the kitchen"}`}
                />
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
