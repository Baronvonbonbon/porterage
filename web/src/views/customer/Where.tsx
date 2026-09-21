// Setting where you are (docs/IMPROVEMENTS.md §5).
//
// Three ways in, and the order they appear in is the order of what they cost:
// what's already saved (free), a typed search (tells a search server the exact
// string), a map pin (tells a tile server a rough area). The cost of each is
// written beside it rather than collected in a policy nobody opens.
//
// There is no search-as-you-type. Sending every prefix of "1200 E 6th St" is
// strictly more than sending it once, and a search that fires on a keystroke is
// a search nobody decided to make.

import { useState } from "react";
import { findPlace, shortLabel, type Place } from "../../order/geocode";
import { formatDegrees, type Position } from "../../order/geo";
import { MapPick } from "../pickers/MapPick";
import { RADIUS_RUNGS, saveSettings, settings } from "../../settings";
import { Choose } from "../pickers/Choose";
import { errorText, metres } from "../../format";

export function Where({
  at,
  radius,
  onSet,
  onRadius,
  onDone,
}: {
  at: Position | null;
  radius: number;
  onSet: (at: Position) => void;
  onRadius: (metres: number) => void;
  onDone?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onMap, setOnMap] = useState(false);

  async function search() {
    const text = query.trim();
    if (text.length < 3) return;
    setSearching(true);
    setError(null);
    setFound(null);
    try {
      setFound(await findPlace(text));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSearching(false);
    }
  }

  if (onMap) {
    return (
      <MapPick
        initial={at ?? { lat: 37_774_900, lon: -122_419_400 }}
        onPick={(picked) => {
          onSet(picked);
          setOnMap(false);
        }}
        onCancel={() => setOnMap(false)}
      />
    );
  }

  return (
    <section>
      <h2>Where are you?</h2>

      {at && (
        <p className="lead">
          {formatDegrees(at.lat)}, {formatDegrees(at.lon)}
          <br />
          <span className="muted">
            Showing places within {metres(radius)}. This stays on your phone —
            it is never published and never sent with an order.
          </span>
        </p>
      )}

      <div className="actions">
        <input
          value={query}
          placeholder="Address, city, or postcode"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !searching && search()}
        />
        <button
          className="primary"
          disabled={searching || query.trim().length < 3}
          onClick={search}
        >
          {searching ? "searching…" : "Search"}
        </button>
      </div>
      <p className="warn">
        A search sends what you typed to openstreetmap.org — the exact text, not
        a rough area. Nothing is sent while you type, only when you tap Search.
        The map below sends nothing but the squares it draws.
      </p>

      {found?.length === 0 && (
        <p className="muted">Nothing matched that. Try fewer words.</p>
      )}
      {found && found.length > 0 && (
        <ul className="places">
          {found.map((place, i) => (
            <li key={`${place.label}-${i}`}>
              <button
                className="link"
                onClick={() => {
                  onSet(place.at);
                  setFound(null);
                  setQuery("");
                }}
              >
                {shortLabel(place.label)}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="actions">
        <button onClick={() => setOnMap(true)}>
          {at ? "Move the pin on a map" : "Drop a pin on a map"}
        </button>
      </div>

      <h3>How far to look</h3>
      <Choose
        label="How far"
        value={String(radius)}
        onPick={(value) => {
          onRadius(Number(value));
          saveSettings({ radius: Number(value) });
        }}
        choices={RADIUS_RUNGS.map((m) => ({
          value: String(m),
          label: metres(m),
        }))}
      />

      {error && <p className="error">{error}</p>}

      {at && onDone && (
        <div className="actions">
          <button className="primary" onClick={onDone}>
            Show me what's near
          </button>
        </div>
      )}
    </section>
  );
}

/** The saved radius, for a caller that only wants the number. */
export const savedRadius = (): number => settings().radius;
