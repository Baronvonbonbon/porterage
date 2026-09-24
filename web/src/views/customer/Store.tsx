// One venue's menu (docs/IMPROVEMENTS.md §5).
//
// Sections in the vendor's own order and the vendor's own words, because a
// section is only ever a heading on this one menu — nobody else has to agree
// with it. That is the opposite of a label, which is filtered on across every
// venue and so comes from a fixed vocabulary.
//
// The bag lives in the shell above this screen, not here: someone who backs out
// to look at another place and comes back should find their bag where they left
// it, and a bag held in this component would be gone.

import { useEffect, useState } from "react";
import type { Menu, MenuItem } from "../../order/menu";
import { sectionsOf } from "../../order/menu";
import { bagCount, billFor } from "../../order/bag";
import { photoUrl } from "../../order/shopfront";
import { labelWord } from "../../order/labels";
import { pasWei } from "../../format";
import { Count } from "../pickers/Count";
import { Directions } from "../Directions";
import type { Shop } from "./Browse";

export function Store({
  shop,
  picked,
  onPick,
  onBag,
  onBack,
}: {
  shop: Shop;
  picked: Map<string, number>;
  onPick: (next: Map<string, number>) => void;
  onBag: () => void;
  onBack: () => void;
}) {
  const { venue, menu, stars } = shop;
  const count = bagCount(picked);
  const bill = menu ? billFor(menu, picked) : null;

  if (!menu)
    return (
      <section>
        <button className="back" onClick={onBack}>
          back
        </button>
        <h2>Venue #{venue.id.toString()}</h2>
        <p className="muted">
          This place has published no menu, so there is nothing to order from it
          yet.
        </p>
      </section>
    );

  const set = (item: MenuItem, n: number) => {
    const next = new Map(picked);
    if (n <= 0) next.delete(item.id);
    else next.set(item.id, n);
    onPick(next);
  };

  return (
    <section className="store">
      <button className="back" onClick={onBack}>
        back
      </button>

      <Banner menu={menu} />
      <h2>{menu.name || `Venue #${venue.id}`}</h2>
      <p className="muted">
        {stars}
        {menu.labels?.length
          ? ` · ${menu.labels.map(labelWord).join(", ")}`
          : ""}
        <br />
        <Directions at={venue.at} label={menu.name} what="this place" />
      </p>

      {sectionsOf(menu).map((section) => (
        <div key={section.name || "_rest"}>
          {section.name && <h3>{section.name}</h3>}
          <ul className="menu-list">
            {section.items.map((item) => (
              <li key={item.id}>
                <div className="menu-item">
                  <span>
                    <b>{item.name}</b>
                    {item.note && (
                      <>
                        <br />
                        <span className="muted">{item.note}</span>
                      </>
                    )}
                    <br />
                    <span className="muted">{pasWei(item.price)}</span>
                  </span>
                  <Count
                    label={item.name}
                    value={picked.get(item.id) ?? 0}
                    max={20}
                    onChange={(n) => set(item, n)}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {count > 0 && bill && (
        <div className="bag-bar">
          <button className="primary" onClick={onBag}>
            {count === 1 ? "1 thing" : `${count} things`} · {pasWei(bill.total)}{" "}
            — see the bag
          </button>
        </div>
      )}
    </section>
  );
}

/** The shopfront picture again, wide, so the place is recognisable. */
function Banner({ menu }: { menu: Menu }) {
  const [url, setUrl] = useState<string | null>(null);
  const key = menu.photo;
  useEffect(() => {
    if (!key) return;
    let live = true;
    photoUrl(key).then((found) => live && setUrl(found));
    return () => {
      live = false;
    };
  }, [key]);
  if (!url) return null;
  return <img className="store-banner" src={url} alt="" />;
}
