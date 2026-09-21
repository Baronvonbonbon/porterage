// The venue counter (docs/PLAN.md §4 step 3): register once, then take orders.

import { useCallback, useEffect, useState } from "react";
import type { Wallet } from "ethers";
import { hostAccount, type HostAccount } from "../hostchain";
import { sessionKey } from "../keys";
import { deployed } from "../contracts";
import {
  allVenues,
  myVenues,
  registerVenue,
  setVenueSigner,
  type Venue as VenueRow,
} from "../order/venue";
import { formatDegrees, parseDegrees } from "../order/geo";
import { recentOrders, Status, statusName, type Order } from "../order/orders";
import { encodePickup, nowSeconds, signPickup } from "../order/handoff";
import { QrShow } from "./Qr";
import { menuOf, publishMenu, type Menu, type MenuItem } from "../order/menu";
import { LABELS, MAX_LABELS, labelWord } from "../order/labels";
import { MAX_TAX_LINES } from "../order/menu";
import { publishPhoto, shrink } from "../order/shopfront";
import { ChooseMany } from "./pickers/Choose";
import { Amount } from "./pickers/Amount";
import { pasPlain } from "../money/amount";
import {
  basketLine,
  venueTopic,
  watchBaskets,
  type Basket,
} from "../order/kitchen";
import { watchIntros, type Intro } from "../order/chat";
import { ratingText, venueRating } from "../order/ratings";
import { tell } from "../notify";
import { Thread } from "./Thread";
import { errorText, pasWei, short } from "../format";
import { MENU_PUBLIC, VENUE_SEES } from "../copy/privacy";
import { read } from "../contracts";
import { Earnings } from "./Earnings";
import { Funds } from "./Funds";
import { Books } from "./Books";
import { billFor } from "../order/bag";
import { linesOf, record } from "../books/ledger";

type Step = "counter" | "menu" | "takings" | "setup";

export function Venue() {
  /**
   * The venue's details, its takings, the whole menu editor and the live
   * orders were one page. A counter with a queue read past a menu editor to
   * find its orders, which is the wrong way round: the menu changes weekly and
   * the orders change all day. So Counter is where this opens.
   */
  const [step, setStep] = useState<Step>("counter");
  const [me, setMe] = useState<HostAccount | null>(null);
  const [key, setKey] = useState<Wallet | null>(null);
  const [mine, setMine] = useState<VenueRow[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [lat, setLat] = useState("37.774900");
  const [lon, setLon] = useState("-122.419400");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<{ id: string; text: string } | null>(null);
  const [menu, setMenu] = useState<Menu>({ name: "", items: [] });
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [baskets, setBaskets] = useState<Map<string, Basket>>(new Map());
  /** Order id to whoever introduced themselves on it, and with which key. */
  const [callers, setCallers] = useState<Map<string, Intro>>(new Map());
  const [talkTo, setTalkTo] = useState<string | null>(null);
  const [stars, setStars] = useState<Map<string, string>>(new Map());
  /** What the vault is holding for each venue's payout address. */
  const [takings, setTakings] = useState<Map<string, bigint>>(new Map());
  /** Price text while it is being typed: "1." is not yet a number. */
  const [prices, setPrices] = useState<Map<string, string>>(new Map());

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [acct, k] = await Promise.all([hostAccount(), sessionKey(0)]);
      setMe(acct);
      setKey(k);
      if (deployed()) {
        const rows = await myVenues(acct.evm);
        setMine(rows);
        const first = rows[0];
        if (first && menuFor !== first.id.toString()) {
          setMenuFor(first.id.toString());
          const published = first.metadataURI
            ? await menuOf(first.metadataURI)
            : null;
          setMenu(
            published ?? {
              name: "",
              items: [{ id: "a", name: "", price: 10n ** 18n }],
            }
          );
        }
        // How it is rated and what it is owed, together: they are the two
        // numbers an operator opens this screen for.
        const vault = read("vault");
        const [rated, owed] = await Promise.all([
          Promise.all(
            rows.map(
              async (v) =>
                [v.id.toString(), ratingText(await venueRating(v.id))] as const
            )
          ),
          Promise.all(
            rows.map(
              async (v) =>
                [v.id.toString(), await vault.balanceOf(v.payout)] as const
            )
          ),
        ]);
        setStars(new Map(rated));
        setTakings(new Map(owed));
        const ids = new Set(rows.map((v) => v.id.toString()));
        setOrders(
          (await recentOrders()).filter((o) => ids.has(o.venueId.toString()))
        );
        if (!rows.length) await allVenues(1); // warms the read path
      }
    } catch (e) {
      setError(errorText(e));
    }
  }, [menuFor]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Baskets arrive sealed to the counter's key on the venue's own topic.
  useEffect(() => {
    if (!key || !mine.length) return;
    let stop: (() => void) | null = null;
    watchBaskets(key, mine[0].id, (b) => {
      setBaskets((all) => new Map(all).set(b.orderId.toString(), b));
      // Write the sale down as it is charged. The basket is the only place the
      // items ever exist -- the chain records how much, never what, and these
      // statements expire in about an hour -- so if this row is not written
      // now there is nothing to go back to.
      const bill = billFor(menu, b.items);
      const chain = orders.find((o) => o.id === b.orderId);
      record({
        kind: "sale",
        orderId: b.orderId.toString(),
        at: Date.now(),
        venueId: mine[0].id.toString(),
        venue: menu.name || undefined,
        chainValue: chain?.orderValue.toString(),
        ...linesOf(bill),
      }).catch(() => undefined);
    })
      .then((s) => (stop = s))
      .catch((e) => setError(errorText(e)));
    return () => stop?.();
  }, [key, mine, menu, orders]);

  // A basket is sealed with a throwaway key, so whoever wants an answer says
  // hello separately, on the same topic and sealed the same way.
  useEffect(() => {
    if (!key || !mine.length) return;
    let stop: (() => void) | null = null;
    watchIntros(key, venueTopic(mine[0].id), (intro) =>
      setCallers((all) => new Map(all).set(intro.orderId.toString(), intro))
    )
      .then((s) => (stop = s))
      .catch(() => undefined);
    return () => stop?.();
  }, [key, mine]);

  /** Edit one tax line, or drop it when `patch` is null. */
  const setTax = (n: number, patch: { name: string; bps: number } | null) => {
    const lines = [...(menu.tax ?? [])];
    if (patch === null) lines.splice(n, 1);
    else lines[n] = patch;
    setMenu({ ...menu, tax: lines });
  };

  const setItem = (n: number, patch: Partial<MenuItem>) =>
    setMenu({
      ...menu,
      items: menu.items.map((it, i) => (i === n ? { ...it, ...patch } : it)),
    });

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
            Register the counter once, at its own position. Drivers prove they
            collected from here by both signing that position, so it never needs
            the phone's location afterwards.
          </p>
          <div className="actions">
            <label>
              Latitude{" "}
              <input
                inputMode="decimal"
                value={lat}
                onChange={(e) => setLat(e.target.value)}
                size={11}
              />
            </label>
            <label>
              Longitude{" "}
              <input
                inputMode="decimal"
                value={lon}
                onChange={(e) => setLon(e.target.value)}
                size={11}
              />
            </label>
            <button
              disabled={!!busy || !valid || !key}
              onClick={() =>
                run("Registering", () =>
                  registerVenue({ lat: at.lat!, lon: at.lon! }, key!)
                )
              }
            >
              Register this venue
            </button>
          </div>
        </>
      )}

      {mine.length > 0 && (
        <nav className="steps">
          {(
            [
              ["counter", "Counter"],
              ["menu", "Menu"],
              ["takings", "Takings"],
              ["setup", "Setup"],
            ] as [Step, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              className={step === id ? "on" : ""}
              onClick={() => setStep(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      )}

      {step === "setup" &&
        mine.map((v) => (
          <div key={v.id.toString()}>
            <p className="lead">
              {stars.get(v.id.toString()) ?? "…"} ·{" "}
              {takings.has(v.id.toString())
                ? `${pasWei(takings.get(v.id.toString())!)} waiting`
                : "…"}
            </p>
            <p className="muted">
              {v.pickups === 1
                ? "One order collected from this counter."
                : `${v.pickups} orders collected from this counter.`}{" "}
              Takings land in the vault when the driver collects, not when the
              order is delivered — the goods are yours to be paid for either
              way.
            </p>
            <dl>
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
                    <button
                      className="link"
                      disabled={!!busy || !key}
                      onClick={() =>
                        run("Updating", () => setVenueSigner(v.id, key!))
                      }
                    >
                      use this phone
                    </button>
                  </>
                )}
              </dd>
            </dl>
          </div>
        ))}

      {step === "takings" && mine.length > 0 && (
        <>
          {/* The rating and the money on one screen, and the way the money
              actually comes out right underneath. The payout address is the
              venue's, which may not be this phone's account. */}
          {mine.map((v) => (
            <p className="lead" key={v.id.toString()}>
              {stars.get(v.id.toString()) ?? "…"} ·{" "}
              {takings.has(v.id.toString())
                ? `${pasWei(takings.get(v.id.toString())!)} waiting`
                : "…"}
            </p>
          ))}
          <Earnings account={mine[0].payout} />
          <Books kind="sale" backup />
          <Funds />
        </>
      )}

      {step === "menu" && mine.length > 0 && (
        <>
          <h3>Menu</h3>
          <p className="muted">{MENU_PUBLIC}</p>
          <div className="actions">
            <label>
              Called{" "}
              <input
                value={menu.name}
                onChange={(e) => setMenu({ ...menu, name: e.target.value })}
                size={16}
              />
            </label>
            {menu.items.map((it, i) => (
              <div className="menu-row" key={it.id}>
                <label>
                  <input
                    placeholder="item"
                    value={it.name}
                    onChange={(e) => setItem(i, { name: e.target.value })}
                    size={14}
                  />
                </label>
                {/* The last screen still parsing an amount by hand. A price
                    typed as "1.2345678" used to round away in silence. */}
                <Amount
                  label="costs"
                  value={prices.get(it.id) ?? pasPlain(it.price)}
                  onChange={(text, wei) => {
                    setPrices(new Map(prices).set(it.id, text));
                    if (wei !== null) setItem(i, { price: wei });
                  }}
                />
                {/* Free text, and it stays free text: a section is only ever a
                    heading on this one menu, so nobody else has to agree with
                    it. Labels are the opposite — they're filtered on across
                    every venue, so they come from a fixed list. */}
                <label>
                  under{" "}
                  <input
                    placeholder="Drinks"
                    value={it.section ?? ""}
                    onChange={(e) => setItem(i, { section: e.target.value })}
                    size={10}
                  />
                </label>
                <label>
                  <input
                    placeholder="a line about it (optional)"
                    value={it.note ?? ""}
                    onChange={(e) => setItem(i, { note: e.target.value })}
                    size={20}
                  />
                </label>
              </div>
            ))}
            <button
              className="link"
              onClick={() =>
                setMenu({
                  ...menu,
                  items: [
                    ...menu.items,
                    {
                      id: String.fromCharCode(97 + menu.items.length),
                      name: "",
                      price: 10n ** 18n,
                    },
                  ],
                })
              }
            >
              Add another item
            </button>
            {/* The shopfront picture. One host prompt and several seconds,
                which is why it is its own button and not part of publishing:
                a vendor changing a price shouldn't pay for an upload. */}
            <label>
              Picture{" "}
              <input
                type="file"
                accept="image/*"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  await run("Storing the picture", async () => {
                    const small = await shrink(file);
                    setMenu({ ...menu, photo: await publishPhoto(small) });
                  });
                }}
              />
            </label>
            {menu.photo && (
              <p className="ok">
                Picture stored. It goes live when you publish the menu.
              </p>
            )}

            <p className="muted">
              Charges on top of the goods — tax, VAT, a service charge.
              Customers see each one named, with its rate, before they pay.
              You're paid all of it at pickup, and remitting it is yours to do:
              the contract can't tell tax from a croissant.
            </p>
            {(menu.tax ?? []).map((line, i) => (
              <label key={i}>
                <input
                  placeholder="State tax"
                  value={line.name}
                  onChange={(e) =>
                    setTax(i, { name: e.target.value, bps: line.bps })
                  }
                  size={12}
                />{" "}
                <input
                  inputMode="decimal"
                  size={4}
                  value={(line.bps / 100).toString()}
                  onChange={(e) =>
                    setTax(i, {
                      name: line.name,
                      bps: Math.round((Number(e.target.value) || 0) * 100),
                    })
                  }
                />{" "}
                %{" "}
                <button className="link" onClick={() => setTax(i, null)}>
                  remove
                </button>
              </label>
            ))}
            {(menu.tax ?? []).length < MAX_TAX_LINES && (
              <button
                className="link"
                onClick={() =>
                  setMenu({
                    ...menu,
                    tax: [...(menu.tax ?? []), { name: "", bps: 0 }],
                  })
                }
              >
                Add a charge
              </button>
            )}

            <p className="muted">
              What kind of place is this? Up to {MAX_LABELS}, so customers can
              find you.
            </p>
            <ChooseMany
              label="What kind of place"
              values={menu.labels ?? []}
              max={MAX_LABELS}
              onPick={(labels) => setMenu({ ...menu, labels })}
              choices={LABELS.map((l) => ({ value: l, label: labelWord(l) }))}
            />
            <button
              className="primary"
              disabled={
                !!busy || !key || !menu.items.some((i) => i.name.trim())
              }
              onClick={() =>
                run("Publishing the menu", () =>
                  publishMenu(mine[0].id, {
                    ...menu,
                    items: menu.items.filter((i) => i.name.trim()),
                    // Customers seal their baskets to this, so only the counter reads them.
                    counterKey: key!.signingKey.compressedPublicKey,
                  })
                )
              }
            >
              Publish the menu
            </button>
          </div>
        </>
      )}

      {step === "counter" && mine.length > 0 && (
        <>
          <h3>Orders</h3>
          {orders.length === 0 && <p className="muted">No orders yet.</p>}
          <p className="muted">{VENUE_SEES}</p>
          <ul>
            {orders.map((o) => {
              const venue = mine.find((v) => v.id === o.venueId)!;
              return (
                <li key={o.id.toString()}>
                  <b>#{o.id.toString()}</b> — {statusName(o.status)}, goods{" "}
                  {pasWei(o.orderValue)}
                  {baskets.has(o.id.toString()) && (
                    <>
                      <br />
                      <b>{basketLine(menu, baskets.get(o.id.toString())!)}</b>
                    </>
                  )}
                  {o.driver !== "0x0000000000000000000000000000000000000000" &&
                    ` — driver ${short(o.driver)}`}
                  {callers.has(o.id.toString()) && key && (
                    <>
                      {" "}
                      <button
                        className="link"
                        onClick={() =>
                          setTalkTo(
                            talkTo === o.id.toString() ? null : o.id.toString()
                          )
                        }
                      >
                        {talkTo === o.id.toString()
                          ? "hide messages"
                          : "messages"}
                      </button>
                    </>
                  )}
                  {talkTo === o.id.toString() &&
                    key &&
                    callers.has(o.id.toString()) && (
                      <Thread
                        mine={key}
                        theirs={callers.get(o.id.toString())!.publicKey}
                        orderId={o.id}
                        title={`#${o.id} — the ${
                          callers.get(o.id.toString())!.role
                        }`}
                      />
                    )}
                  {o.status === Status.Assigned && key && (
                    <>
                      {" "}
                      <button
                        className="link"
                        disabled={!!busy}
                        onClick={() =>
                          run("Signing the handover", async () => {
                            const timestamp = nowSeconds();
                            const signature = await signPickup(
                              key,
                              o.id,
                              key.address,
                              venue.at,
                              timestamp
                            );
                            setCode({
                              id: o.id.toString(),
                              text: encodePickup({
                                orderId: o.id,
                                at: venue.at,
                                timestamp,
                                signature,
                              }),
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
              <QrShow
                value={code.text}
                caption="Let the driver scan this. It's the counter's signature, and it's good for a few minutes."
              />
              <button className="link" onClick={() => setCode(null)}>
                Done
              </button>
            </>
          )}
        </>
      )}

      {me && !deployed() && (
        <p className="notice">The contracts aren't deployed yet.</p>
      )}
      {busy && <p className="muted">{busy}… approve it in the Polkadot app.</p>}
      {error && <p className="error">{error}</p>}
      <button className="link" onClick={refresh} disabled={!!busy}>
        Refresh
      </button>
    </section>
  );
}
