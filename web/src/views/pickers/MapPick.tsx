// Choosing the drop on a map (docs/PLAN.md §4).
//
// Plain raster tiles in <img> tags: no map library, no WebGL, nothing to load
// before the page works. The pin is always the middle of the view, so dropping
// it is just panning — no tap-to-coordinate arithmetic, and it works the same
// with a thumb as with a mouse.
//
// It starts at the venue, because the app can't read the phone's position
// (the WebView refuses geolocation) and a drop is usually near where the food is.
//
// WHAT THE MAP COSTS IN PRIVACY, and why it's still opt-in: tiles are fetched
// from a public tile server, so that server sees the rough area being looked at
// from this device's address. It never sees the pin — a tile covers a few
// hundred metres — and nothing about the order goes with the request. Typing
// coordinates instead sends nothing at all, which is why that stays available.

import { useEffect, useRef, useState } from "react";
import type { Position } from "../../order/geo";
import { formatDegrees, metresBetween } from "../../order/geo";
import { MAP_TILES } from "../../copy/privacy";
import { metres } from "../../format";

import {
  MAX_ZOOM,
  MIN_ZOOM,
  TILE,
  latToY,
  lonToX,
  panned,
  wrapX,
} from "../../order/tiles";

const TILES = "https://tile.openstreetmap.org";

export function MapPick({
  venue,
  initial,
  onPick,
  onCancel,
}: {
  /**
   * Where to start, and what to measure from. Absent when there is nothing to
   * measure from — someone setting their own location has no venue, and the
   * distance line would be measuring from nowhere.
   */
  venue?: Position;
  initial?: Position;
  onPick: (p: Position) => void;
  onCancel: () => void;
}) {
  const start = initial ?? venue ?? { lat: 0, lon: 0 };
  const [zoom, setZoom] = useState(16);
  const [centre, setCentre] = useState<Position>(start);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 320, h: 320 });
  const drag = useRef<{ x: number; y: number; centre: Position } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Tile coordinates of the view's centre, and the whole tiles around it.
  const cx = lonToX(centre.lon / 1e6, zoom);
  const cy = latToY(centre.lat / 1e6, zoom);
  const cols = Math.ceil(size.w / TILE) + 2;
  const rows = Math.ceil(size.h / TILE) + 2;
  const left = Math.floor(cx - cols / 2);
  const top = Math.floor(cy - rows / 2);

  const tiles = [];
  for (let i = 0; i <= cols; i++) {
    for (let j = 0; j <= rows; j++) {
      const x = left + i;
      const y = top + j;
      if (y < 0 || y >= 2 ** zoom) continue;
      const wrapped = wrapX(x, zoom);
      tiles.push({
        key: `${zoom}/${wrapped}/${y}`,
        url: `${TILES}/${zoom}/${wrapped}/${y}.png`,
        dx: (x - cx) * TILE + size.w / 2,
        dy: (y - cy) * TILE + size.h / 2,
      });
    }
  }

  const moveBy = (dx: number, dy: number, from: Position) =>
    setCentre(panned(from, dx, dy, zoom));

  const away = venue ? metresBetween(centre, venue) : null;

  return (
    <div className="map-pick">
      <div
        ref={box}
        className="map-view"
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, centre };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          moveBy(
            e.clientX - drag.current.x,
            e.clientY - drag.current.y,
            drag.current.centre
          );
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        {tiles.map((t) => (
          <img
            key={t.key}
            src={t.url}
            alt=""
            draggable={false}
            style={{ left: t.dx, top: t.dy }}
          />
        ))}
        <div className="map-pin">📍</div>
      </div>

      <p className="muted">
        {formatDegrees(centre.lat)}, {formatDegrees(centre.lon)}
        {away !== null && ` — ${metres(away)} from the venue`}. Drag to move the
        pin.
      </p>
      <p className="warn">{MAP_TILES}</p>

      <div className="actions">
        <div className="map-zoom">
          <button disabled={zoom >= MAX_ZOOM} onClick={() => setZoom(zoom + 1)}>
            Zoom in
          </button>
          <button disabled={zoom <= MIN_ZOOM} onClick={() => setZoom(zoom - 1)}>
            Zoom out
          </button>
        </div>
        <button className="primary" onClick={() => onPick(centre)}>
          Drop here
        </button>
        <button className="link" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="muted">Map data © OpenStreetMap contributors.</p>
    </div>
  );
}
