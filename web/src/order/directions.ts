// Getting someone to a place (docs/IMPROVEMENTS.md §4).
//
// Coordinates are not directions. A driver holding "37.784900, -122.419400"
// still has to get there, and the phone already has something that does that
// well — so the job here is to hand the position to it and get out of the way.
//
// The ladder, and why it is in this order:
//
//   1. `geo:` through the host's `navigateTo`. If the host passes it to the OS,
//      the phone's own map app opens, Porterage stays where it was, and nothing
//      is sent to anybody. This is the only rung that is free.
//   2. A web map, but only on a SECOND deliberate tap. `navigateTo` with an
//      http(s) URL navigates the WebView — sonde measured exactly that, by
//      pointing it at its own page and watching it reload — so this does not
//      open a tab, it REPLACES the app. Doing that automatically would throw
//      away an order someone is in the middle of. It also tells whoever runs
//      the map where somebody is going, which is worth a sentence on screen.
//   3. The coordinates, copied. Sends nothing anywhere, works with whatever the
//      person already uses, and is the rung that can never fail.
//
// Whether rung 1 works at all is UNMEASURED: `navigateTo` passes on the phone
// (sonde, 28–44 ms) but nothing has yet checked what it does with a `geo:` URI.
// So the result is reported rather than assumed, and the UI shows rung 2 and 3
// the moment rung 1 says no.

import { navigateTo } from "@parity/product-sdk-host";
import { inHost } from "../host";
import { formatDegrees, type Position } from "./geo";

export type Outcome =
  /** The host took it; a map app should be open. */
  | "opened"
  /** The host is there but would not take it — fall down the ladder. */
  | "refused"
  /** No host at all (a desktop browser), so there is nothing to ask. */
  | "no-host";

const plain = (at: Position) =>
  `${formatDegrees(at.lat)},${formatDegrees(at.lon)}`;

/**
 * The standard geo URI. `q` is repeated on purpose: without it some map apps
 * centre the map and drop no pin, which loses the one thing being sent.
 */
export function geoUrl(at: Position, label?: string): string {
  const point = plain(at);
  const q = label ? `${point}(${encodeURIComponent(label)})` : point;
  return `geo:${point}?q=${q}`;
}

/**
 * OpenStreetMap, not Google: the app already draws OSM tiles, and of the maps
 * that will take a pin from a URL it is the one that asks least of whoever
 * follows the link.
 */
export function webMapUrl(at: Position): string {
  const [lat, lon] = [formatDegrees(at.lat), formatDegrees(at.lon)];
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
}

/** Ask the phone to open its own map app. Never navigates the app away. */
export async function openInMapApp(
  at: Position,
  label?: string
): Promise<Outcome> {
  if (!(await inHost())) return "no-host";
  try {
    const result = await navigateTo(geoUrl(at, label));
    return result.ok ? "opened" : "refused";
  } catch {
    return "refused";
  }
}

/** Put the coordinates on the clipboard. False when the browser won't allow it. */
export async function copyPosition(at: Position): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(plain(at));
    return true;
  } catch {
    return false;
  }
}

export const asText = plain;
