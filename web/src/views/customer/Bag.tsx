// The bag, the bill, and placing the order (docs/IMPROVEMENTS.md §5).
//
// Every number on this screen comes from one call to `billFor`. Nothing here
// adds a percentage, and nothing rounds: if this screen and the transaction
// could disagree, they eventually would, and a bill that doesn't match the
// charge is the thing people never forgive.
//
// The tax lines are the vendor's, shown itemised and named as the vendor names
// them, with the rate beside each. A total that appeared from nowhere is how
// someone stops trusting a bill — and the vendor being the one who set them is
// exactly why they get shown rather than folded in.

import type { Menu } from "../../order/menu";
import { billFor } from "../../order/bag";
import { pasWei } from "../../format";
import { Count } from "../pickers/Count";
import { Amount } from "../pickers/Amount";
import { MapPick } from "../pickers/MapPick";
import { formatDegrees, type Position } from "../../order/geo";
import { cellOf, cellVagueness } from "../../order/area";
import { coarseArea } from "../../copy/privacy";
import type { Shop } from "./Browse";

export function Bag({
  shop,
  picked,
  onPick,
  drop,
  onDrop,
  tellArea,
  onTellArea,
  fare,
  onFare,
  placing,
  onPlace,
  onBack,
}: {
  shop: Shop;
  picked: Map<string, number>;
  onPick: (next: Map<string, number>) => void;
  drop: Position | null;
  onDrop: (at: Position | null) => void;
  tellArea: boolean;
  onTellArea: (on: boolean) => void;
  fare: string;
  onFare: (text: string, wei: bigint | null) => void;
  placing: string | null;
  onPlace: () => void;
  onBack: () => void;
}) {
  const menu = shop.menu as Menu;
  const bill = billFor(menu, picked);

  if (!bill.items.length)
    return (
      <section>
        <button className="link" onClick={onBack}>
          ← back
        </button>
        <h2>Your bag</h2>
        <p className="muted">Nothing in it yet.</p>
      </section>
    );

  return (
    <section>
      <button className="link" onClick={onBack}>
        ← back to {menu.name || "the menu"}
      </button>
      <h2>Your bag</h2>

      <ul className="bill">
        {bill.items.map(({ item, count, wei }) => (
          <li key={item.id}>
            <span>
              <b>{item.name}</b>
              <br />
              <span className="muted">{pasWei(item.price)} each</span>
            </span>
            <Count
              label={item.name}
              value={count}
              max={20}
              onChange={(n) => {
                const next = new Map(picked);
                if (n <= 0) next.delete(item.id);
                else next.set(item.id, n);
                onPick(next);
              }}
            />
            <span className="bill-amount">{pasWei(wei)}</span>
          </li>
        ))}
      </ul>

      <dl className="totals">
        <dt>Goods</dt>
        <dd>{pasWei(bill.goods)}</dd>
        {bill.tax.map((line) => (
          <div key={line.name} className="contents">
            <dt>
              {line.name}{" "}
              <span className="muted">
                {(line.bps! / 100).toFixed(2).replace(/\.?0+$/, "")}%
              </span>
            </dt>
            <dd>{pasWei(line.wei)}</dd>
          </div>
        ))}
        <dt className="total">To the venue</dt>
        <dd className="total">{pasWei(bill.total)}</dd>
      </dl>
      {bill.tax.length > 0 && (
        <p className="muted">
          The named charges are set by this venue and paid to it with the goods.
          Porterage doesn't take any of it and can't tell what it's for.
        </p>
      )}

      <h3>Delivery</h3>
      <Amount
        label="Pay a driver up to"
        value={fare}
        onChange={onFare}
        presets={[1, 2, 5]}
        hint="Drivers bid against this. You pick which bid to accept."
      />

      <h3>Where it goes</h3>
      {drop ? (
        <p className="muted">
          {formatDegrees(drop.lat)}, {formatDegrees(drop.lon)}{" "}
          <button className="link" onClick={() => onDrop(null)}>
            move
          </button>
          <br />
          Only the driver you pick is told this, and only once it has the job.
        </p>
      ) : (
        <MapPick
          venue={shop.venue.at}
          onPick={onDrop}
          onCancel={() => undefined}
        />
      )}

      {drop && (
        <>
          <label>
            <input
              type="checkbox"
              checked={tellArea}
              onChange={(e) => onTellArea(e.target.checked)}
            />{" "}
            Let drivers see roughly where this goes
          </label>
          {tellArea && (
            <p className="warn">
              {coarseArea(
                `${formatDegrees(cellOf(drop).lat)}, ${formatDegrees(
                  cellOf(drop).lon
                )}`,
                cellVagueness(drop.lat)
              )}
            </p>
          )}
        </>
      )}

      <div className="actions">
        <button
          className="primary"
          disabled={!!placing || !drop}
          onClick={onPlace}
        >
          {placing ?? `Place the order — ${pasWei(bill.total)} + the fare`}
        </button>
      </div>
      {placing && (
        <p className="muted">{placing}… approve it in the Polkadot app.</p>
      )}
    </section>
  );
}
