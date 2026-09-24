// What's near you (docs/IMPROVEMENTS.md §5).
//
// A grid of tiles, because that is what people already know how to read: a
// picture, a name, a rating, one word about what it is, and roughly what it
// costs. Nothing here is new information — the app had all five before, spread
// down a list of `<dl>` rows that nobody could compare at a glance.
//
// The cost of a grid is honest and worth stating: drawing it needs every
// venue's menu, because the rating, the price tier, the label and the picture
// all live in the menu document. The menu cache pays that once per venue
// (`order/menu.ts`), and the picture cache once per picture — both keyed by a
// Bulletin key, which is a content hash, so neither can ever be stale.

import { useEffect, useState } from "react";
import type { Venue } from "../../order/venue";
import type { Menu } from "../../order/menu";
import { priceTier, tierGlyphs } from "../../order/bag";
import {
  labelWord,
  matchesLabels,
  LABELS,
  type Label,
} from "../../order/labels";
import { photoUrl } from "../../order/shopfront";
import type { Position } from "../../order/geo";
import { metres } from "../../format";
import { ChooseMany } from "../pickers/Choose";
import { Waiting, Empty } from "../State";

export interface Shop {
  venue: Venue;
  menu: Menu | null;
  stars: string;
  away: number | null;
}

export function Browse({
  shops,
  loading,
  symbol,
  here,
  radius,
  onOpen,
  onWhere,
}: {
  shops: Shop[];
  loading: boolean;
  symbol: string;
  here: Position | null;
  radius: number;
  onOpen: (shop: Shop) => void;
  onWhere: () => void;
}) {
  const [wanted, setWanted] = useState<Label[]>([]);

  const near = shops
    .filter((s) => (here && s.away !== null ? s.away <= radius : true))
    .filter((s) => matchesLabels(s.menu?.labels ?? [], wanted))
    // Somewhere you can actually order from comes first; after that, closest
    // when there's a pin to measure from, otherwise the order they arrived in.
    .sort((a, b) => {
      if (!!a.menu !== !!b.menu) return a.menu ? -1 : 1;
      return a.away === null || b.away === null ? 0 : a.away - b.away;
    });

  return (
    <section>
      <div className="where-bar">
        <button className="link" onClick={onWhere}>
          {here ? `within ${metres(radius)} of your pin` : "set where you are"}
        </button>
      </div>

      <ChooseMany
        label="What kind of place"
        values={wanted}
        onPick={setWanted}
        choices={LABELS.map((l) => ({ value: l, label: labelWord(l) }))}
      />

      {loading && <Waiting what="places near you" />}

      {!loading && near.length === 0 && (
        <Empty
          what={here ? `Nothing within ${metres(radius)}.` : "No places yet."}
          next={
            here
              ? "Try a wider radius, or fewer kinds of place."
              : "Set where you are to see what's close."
          }
        />
      )}

      <div className="tiles">
        {near.map((shop) => (
          <Tile
            key={shop.venue.id.toString()}
            shop={shop}
            symbol={symbol}
            onOpen={() => onOpen(shop)}
          />
        ))}
      </div>
    </section>
  );
}

function Tile({
  shop,
  symbol,
  onOpen,
}: {
  shop: Shop;
  symbol: string;
  onOpen: () => void;
}) {
  const { venue, menu, stars, away } = shop;
  const tier = menu ? priceTier(menu) : null;
  const top = menu?.labels?.[0];

  return (
    <button className="tile" onClick={onOpen}>
      <Picture menu={menu} name={menu?.name ?? `#${venue.id}`} />
      <b className="tile-name">
        {menu?.name || `Venue #${venue.id}`}
        {menu?.demo && <span className="demo-tag">demo</span>}
      </b>
      <span className="tile-facts">
        {stars}
        {tier && ` · ${tierGlyphs(tier, symbol)}`}
        {away !== null && ` · ${metres(away)}`}
      </span>
      {top && <span className="tile-tag">{labelWord(top)}</span>}
    </button>
  );
}

/**
 * The picture, or the venue's initials. A tile always draws something the same
 * size: a grid that reflows as pictures arrive is worse than a grid with no
 * pictures at all, because the thing someone is reaching for moves.
 */
function Picture({ menu, name }: { menu: Menu | null; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const key = menu?.photo;

  useEffect(() => {
    if (!key) return;
    let live = true;
    photoUrl(key).then((found) => live && setUrl(found));
    return () => {
      live = false;
    };
  }, [key]);

  if (url) return <img className="tile-photo" src={url} alt="" />;
  return (
    <span className="tile-photo tile-initials" aria-hidden="true">
      {initials(name)}
    </span>
  );
}

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("") || "?";
