// Saying roughly where a delivery goes, without saying where (docs/PLAN.md §4).
//
// An order carries only Poseidon(lat, lon, salt), so a driver bidding on it has
// no idea whether the drop is round the corner or across the city. That is the
// design working, and it is also the one thing drivers most need to know before
// they bid. So a customer MAY choose to publish a coarse area alongside the
// order — opt-in, per order, and never automatic.
//
// A FIXED GRID, not a fuzzed position. This matters more than it looks. If the
// published point were the true drop plus a random kilometre, then several
// orders from the same address would be several independent samples around it,
// and averaging them would converge on the doorstep. A grid has no such leak:
// the same home always falls in the same cell, however many orders are placed,
// and the cell never narrows. What is revealed is a square, once, and it stays
// a square.
//
// The cell is about 1.1 km on a side. Longitude is scaled by the latitude, so
// the cell stays roughly square instead of getting narrower towards the poles —
// a cell that quietly shrank to 500 m would be claiming more privacy than it
// gives.
//
// What it costs, stated plainly where it's offered: the area is public, it is
// published by the same statement account as everything else this device
// publishes, and a home that orders often is a home in a known square.

import { concat, keccak256, toUtf8Bytes } from "ethers";
import type { Position } from "./geo";
import { publishStatement, subscribeTopics } from "../market/statements";
import { orderTopic } from "./bids";

/** One cell of latitude, in microdegrees: 0.01° is about 1.11 km. */
export const CELL = 10_000;

const radians = (micro: number) => (micro / 1e6) * (Math.PI / 180);

/** How wide a cell is at this latitude, in microdegrees of longitude. */
export function cellWidth(latMicro: number): number {
  const shrink = Math.cos(radians(latMicro));
  // Near the poles the scaling runs away; a whole degree is wide enough there.
  return Math.min(1_000_000, Math.round(CELL / Math.max(shrink, 0.01)));
}

/**
 * The centre of the cell a position falls in. Both sides compute it the same
 * way, so the customer publishes a cell centre and the driver reads one.
 */
export function cellOf(p: Position): Position {
  const lat = Math.round(Math.floor(p.lat / CELL) * CELL + CELL / 2);
  const width = cellWidth(lat);
  return {
    lat,
    lon: Math.round(Math.floor(p.lon / width) * width + width / 2),
  };
}

/**
 * The furthest the real drop can be from the published centre: the distance to
 * a corner of the cell. This is the number to show someone, not the cell's
 * width — "within 800 m of that point" is what they are actually revealing.
 */
export function cellVagueness(latMicro: number): number {
  const halfHeight = (CELL / 2 / 1e6) * 111_320;
  const halfWidth =
    (cellWidth(latMicro) / 2 / 1e6) * 111_320 * Math.cos(radians(latMicro));
  return Math.round(Math.hypot(halfHeight, halfWidth));
}

// ── the statement ────────────────────────────────────────────────────────────

export const AREA = 11;
const VERSION = 1;

/** Not sealed: the point of it is that any driver can read it before bidding. */
export function encodeArea(orderId: bigint, cell: Position): Uint8Array {
  const out = new Uint8Array(18);
  out[0] = VERSION;
  out[1] = AREA;
  let v = orderId;
  for (let i = 9; i >= 2; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  const put = (at: number, micro: number) => {
    const u = BigInt.asUintN(32, BigInt(micro));
    for (let i = 3; i >= 0; i--)
      out[at + i] = Number((u >> BigInt((3 - i) * 8)) & 0xffn);
  };
  put(10, cell.lat);
  put(14, cell.lon);
  return out;
}

export function decodeArea(
  bytes: Uint8Array
): { orderId: bigint; cell: Position } | null {
  if (bytes.length !== 18 || bytes[0] !== VERSION || bytes[1] !== AREA)
    return null;
  let orderId = 0n;
  for (let i = 2; i < 10; i++) orderId = (orderId << 8n) | BigInt(bytes[i]);
  const read = (at: number) => {
    let v = 0n;
    for (let i = 0; i < 4; i++) v = (v << 8n) | BigInt(bytes[at + i]);
    return Number(BigInt.asIntN(32, v));
  };
  const cell = { lat: read(10), lon: read(14) };
  if (Math.abs(cell.lat) > 90_000_000 || Math.abs(cell.lon) > 180_000_000)
    return null;
  return { orderId, cell };
}

/** The channel an order's area goes on, so a second publish replaces the first. */
export const areaChannel = (orderId: bigint): string =>
  keccak256(
    concat([
      toUtf8Bytes("porterage:area"),
      encodeArea(orderId, { lat: 0, lon: 0 }).slice(2, 10),
    ])
  );

// ── publishing and reading ───────────────────────────────────────────────────

/** Publish an order's area. Called only when the customer asked for it. */
export function publishArea(orderId: bigint, drop: Position): Promise<void> {
  return publishStatement(
    orderTopic(orderId),
    areaChannel(orderId),
    encodeArea(orderId, cellOf(drop))
  );
}

/**
 * Watch for areas on a set of orders. A driver calls this for the open orders
 * it can see; orders whose customer published nothing simply never call back.
 */
export function watchAreas(
  orderIds: bigint[],
  heard: (orderId: bigint, cell: Position) => void
): Promise<() => void> {
  const wanted = new Set(orderIds.map((id) => id.toString()));
  return subscribeTopics(orderIds.map(orderTopic), (bytes) => {
    const read = decodeArea(bytes);
    if (read && wanted.has(read.orderId.toString()))
      heard(read.orderId, read.cell);
  });
}
