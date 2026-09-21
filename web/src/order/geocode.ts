// Turning what someone typed into a position (docs/IMPROVEMENTS.md §5).
//
// READ THIS BEFORE USING IT ANYWHERE NEW. This is the most revealing thing the
// app does, and it is worth being plain about why.
//
// The map already fetches tiles from openstreetmap.org, and that tells the tile
// server roughly which square of the world is on screen. A search is worse in
// kind, not just degree: it sends the EXACT STRING someone typed. "1200 E 6th
// St" is not a rough area, it is an address, and very often it is the address
// of the person typing it. Nothing else in Porterage hands a third party
// something that specific — the chain sees a hash, the venue sees a basket, the
// driver sees a doorstep it is delivering to, and all three are the minimum
// that job requires. This is the one place where the app would, if used
// carelessly, tell an uninvolved server where somebody lives.
//
// It exists because the alternative was worse in practice: panning a map to
// find your own house is slow and imprecise, and a delivery to the wrong pin is
// a real failure with a real cost. So the trade is made deliberately, and:
//
//   - it is never automatic. A search happens when someone taps search.
//   - what it costs is on screen, in words, next to the box — not in a privacy
//     policy and not in this comment where only I will read it.
//   - the map pin still works, and is still offered, for anyone who would
//     rather pan than type.
//   - nothing is sent while typing. There is no search-as-you-type here, on
//     purpose: that would send every prefix of an address, which is strictly
//     more than sending it once.
//   - the result is a position. The typed string is never stored, never put in
//     the book, and never leaves this module.
//
// Nominatim's terms ask for no more than one request a second and no heavy
// automated use; a person tapping a button obliges by itself, and `MIN_GAP_MS`
// keeps a fast thumb honest.

import type { Position } from "./geo";

const ENDPOINT = "https://nominatim.openstreetmap.org/search";

/** Nominatim asks for at most one request a second. */
const MIN_GAP_MS = 1_100;

/** A search is a foreground action someone is waiting on. */
const TIMEOUT_MS = 12_000;

export interface Place {
  /** What to show in the list: "1200 E 6th St, Austin, Texas, US". */
  label: string;
  at: Position;
}

let lastCall = 0;

/**
 * Look up a typed place. Returns [] when nothing matched; throws when the
 * search itself failed, so a screen can tell "no such street" from "no
 * network" — they need different words.
 */
export async function findPlace(query: string, limit = 5): Promise<Place[]> {
  const text = query.trim();
  if (text.length < 3) return [];

  const wait = MIN_GAP_MS - (Date.now() - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();

  const url =
    `${ENDPOINT}?format=jsonv2&limit=${limit}&addressdetails=0` +
    `&q=${encodeURIComponent(text)}`;

  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: stop.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok)
      throw new Error(`the search service said ${response.status}`);
    const rows = (await response.json()) as {
      display_name?: string;
      lat?: string;
      lon?: string;
    }[];
    return (Array.isArray(rows) ? rows : [])
      .map(toPlace)
      .filter((p): p is Place => p !== null);
  } catch (e) {
    if ((e as Error).name === "AbortError")
      throw new Error("the search took too long");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Degrees to the microdegrees the rest of the app uses. A row that isn't a
 * real position is dropped rather than repaired: this comes from outside, and
 * a silently-fixed coordinate is a delivery to the wrong place.
 */
function toPlace(row: {
  display_name?: string;
  lat?: string;
  lon?: string;
}): Place | null {
  const lat = Number(row.lat);
  const lon = Number(row.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const label = String(row.display_name ?? "").trim();
  if (!label) return null;
  return {
    label,
    at: { lat: Math.round(lat * 1e6), lon: Math.round(lon * 1e6) },
  };
}

/** Shorten a Nominatim label for a one-line result row. */
export function shortLabel(label: string, parts = 3): string {
  const bits = label.split(",").map((b) => b.trim());
  return bits.length <= parts ? label : bits.slice(0, parts).join(", ");
}
