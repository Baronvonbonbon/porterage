// The customer's app (docs/IMPROVEMENTS.md §5).
//
// This replaces one 1,040-line screen that held thirty pieces of state and did
// six jobs: finding a venue, reading a menu, building a basket, naming a price,
// placing the order, and then watching it happen. Every one of those was on the
// same page at the same time, so the screen was busiest exactly when someone
// knew least about what they were doing.
//
// It is now one step at a time, and each step is a component that owns what it
// needs and nothing else. What lives HERE is only what genuinely spans steps:
//
//   - where you are, and how far you'll look (used by browse, kept by the book)
//   - the bag: which venue, and what's in it (survives leaving a store and
//     coming back, which is why it can't live in the store screen)
//   - what's being placed right now
//
// `Orders` is still its own screen and still owns the live order — the bids,
// the door handoff, the proof, the chat and the rating. That half was never the
// crowded one.

import { useCallback, useEffect, useMemo, useState } from "react";
import { allVenues, type Venue } from "../../order/venue";
import { menuOf, type Menu } from "../../order/menu";
import { ratingText, venueRating } from "../../order/ratings";
import { billFor } from "../../order/bag";
import { linesOf, record as recordEntry } from "../../books/ledger";
import { publishArea } from "../../order/area";
import { placeOrder, type PlaceStage } from "../../order/flow";
import { pasOrNull } from "../../money/amount";
import { metresBetween, type Position } from "../../order/geo";
import { deployed } from "../../contracts";
import { useHere } from "../Here";
import { settings } from "../../settings";
import { errorText } from "../../format";
import { Where } from "./Where";
import { Browse, type Shop } from "./Browse";
import { Store } from "./Store";
import { Bag } from "./Bag";
import { Ordering } from "../Ordering";
import { Wallet } from "../Wallet";
import { Books } from "../Books";

type Step = "browse" | "where" | "store" | "bag" | "orders" | "balance";

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

export function Customer() {
  const [step, setStep] = useState<Step>("browse");
  const [shops, setShops] = useState<Shop[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [here, setHere] = useHere();
  const [radius, setRadius] = useState(() => settings().radius);
  const symbol = useMemo(() => settings().symbol, []);

  /** The bag: one venue at a time, because an order goes to one counter. */
  const [shopId, setShopId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Map<string, number>>(new Map());

  const [drop, setDrop] = useState<Position | null>(null);
  const [tellArea, setTellArea] = useState(false);
  const [fare, setFare] = useState("2");
  const [stage, setStage] = useState<PlaceStage | null>(null);

  const open = shops.find((s) => s.venue.id.toString() === shopId) ?? null;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!deployed()) return;
      const venues = await allVenues(24);
      // Menus, ratings and pictures all come from one place each, and the
      // caches behind them are keyed by content hash, so a second visit to
      // this screen costs nothing.
      const rows = await Promise.all(
        venues.map(async (venue: Venue): Promise<Shop> => {
          const [menu, stars] = await Promise.all([
            venue.metadataURI
              ? menuOf(venue.metadataURI).catch(() => null)
              : Promise.resolve(null),
            venueRating(venue.id)
              .then(ratingText)
              .catch(() => "unrated"),
          ]);
          return { venue, menu, stars, away: null };
        })
      );
      setShops(rows);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Distance is recomputed rather than stored: the pin moves, the venues don't.
  const withDistance = useMemo(
    () =>
      shops.map((s) => ({
        ...s,
        away: here ? metresBetween(here, s.venue.at) : null,
      })),
    [shops, here]
  );

  async function place() {
    if (!open?.menu || !drop) return;
    const fareWei = pasOrNull(fare);
    const bill = billFor(open.menu, picked);
    if (!fareWei || bill.total <= 0n) return;

    setError(null);
    try {
      // orderValue is goods AND the vendor's named charges: the venue is owed
      // both, and is paid both at pickup. The contract has no idea any of it
      // is tax, and doesn't need one (order/menu.ts).
      const { record } = await placeOrder(
        {
          venueId: open.venue.id,
          drop,
          orderValue: bill.total,
          basket: { items: picked, counterKey: open.menu.counterKey },
          tip: 0n,
          maxFare: fareWei,
        },
        setStage
      );
      // The receipt, written after the order exists so a storage failure can
      // never lose an order that already went through. It stays on this
      // device: nothing backs it up, because an itemised history of what a
      // person eats is the one record this design should not make durable.
      recordEntry({
        kind: "purchase",
        orderId: record.id,
        at: Date.now(),
        venueId: open.venue.id.toString(),
        venue: open.menu.name || undefined,
        ...linesOf(bill),
      }).catch(() => undefined);

      if (tellArea) {
        // After the order exists, never as part of placing it: a failed area
        // must not lose an order that already went through.
        await publishArea(BigInt(record.id), drop).catch(() => undefined);
      }
      setPicked(new Map());
      setShopId(null);
      setDrop(null);
      setStep("orders");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setStage(null);
    }
  }

  return (
    <>
      <nav className="steps">
        <button
          className={step === "browse" ? "on" : ""}
          onClick={() => setStep("browse")}
        >
          Browse
        </button>
        <button
          className={step === "orders" ? "on" : ""}
          onClick={() => setStep("orders")}
        >
          Orders
        </button>
        {/* The private balance used to sit above every customer screen, so
            browsing started below a full page of shielding. It is a thing you
            do occasionally and well before ordering, which makes it a step. */}
        <button
          className={step === "balance" ? "on" : ""}
          onClick={() => setStep("balance")}
        >
          Balance
        </button>
      </nav>

      {step === "where" && (
        <Where
          at={here}
          radius={radius}
          onSet={(at) => setHere({ ...at, metres: radius })}
          onRadius={(m) => {
            setRadius(m);
            if (here) setHere({ ...here, metres: m });
          }}
          onDone={() => setStep("browse")}
        />
      )}

      {step === "browse" && (
        <Browse
          shops={withDistance}
          loading={loading}
          symbol={symbol}
          here={here}
          radius={radius}
          onWhere={() => setStep("where")}
          onOpen={(shop) => {
            // A different venue means a different counter, so the bag starts
            // again rather than quietly mixing two menus.
            if (shop.venue.id.toString() !== shopId) setPicked(new Map());
            setShopId(shop.venue.id.toString());
            setStep("store");
          }}
        />
      )}

      {step === "store" && open && (
        <Store
          shop={open}
          picked={picked}
          onPick={setPicked}
          onBag={() => setStep("bag")}
          onBack={() => setStep("browse")}
        />
      )}

      {step === "bag" && open && (
        <Bag
          shop={open}
          picked={picked}
          onPick={setPicked}
          drop={drop}
          onDrop={setDrop}
          tellArea={tellArea}
          onTellArea={setTellArea}
          fare={fare}
          onFare={(text) => setFare(text)}
          placing={stage ? STAGE_TEXT[stage] : null}
          onPlace={place}
          onBack={() => setStep("store")}
        />
      )}

      {step === "orders" && <Ordering />}

      {step === "balance" && (
        <>
          <Wallet />
          <Books kind="purchase" />
        </>
      )}

      {error && <p className="error">{error}</p>}
    </>
  );
}
