// Web-Mercator tile arithmetic for the drop map (views/MapPick.tsx).
//
// Tiles are the standard OpenStreetMap scheme: at zoom z the world is 2^z tiles
// square, x runs west to east and y north to south. Kept apart from the view so
// the arithmetic can be checked on its own.

export const TILE = 256;
export const MIN_ZOOM = 13;
export const MAX_ZOOM = 18;

export const lonToX = (lon: number, z: number): number =>
  ((lon + 180) / 360) * 2 ** z;

export const latToY = (lat: number, z: number): number => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

export const xToLon = (x: number, z: number): number =>
  (x / 2 ** z) * 360 - 180;

export const yToLat = (y: number, z: number): number => {
  const n = Math.PI - 2 * Math.PI * (y / 2 ** z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

/** Wrap a tile column round the world, so panning past the date line still loads tiles. */
export const wrapX = (x: number, z: number): number =>
  ((x % 2 ** z) + 2 ** z) % 2 ** z;

/** Move a centre (microdegrees) by a drag in pixels, at this zoom. */
export function panned(
  centre: { lat: number; lon: number },
  dx: number,
  dy: number,
  z: number
) {
  const x = lonToX(centre.lon / 1e6, z) - dx / TILE;
  const y = latToY(centre.lat / 1e6, z) - dy / TILE;
  return {
    lat: Math.round(yToLat(y, z) * 1e6),
    lon: Math.round(xToLon(x, z) * 1e6),
  };
}
