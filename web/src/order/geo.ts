// Positions, as the contracts and the circuit see them (docs/PLAN.md §4).
//
// Coordinates are microdegrees, offset so they're never negative inside the
// field: latEnc = lat + 90_000_000, lonEnc = lon + 180_000_000. A drop is never
// on-chain in the clear — only Poseidon(latEnc, lonEnc, salt), opened later by
// the proximity proof.

// Per-arity entry points, not the package barrel. `poseidon-lite`'s index
// re-exports all sixteen arities and each one drags in its own table of round
// constants — 609 kB for the three this app actually uses.
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";
import { toBigInt } from "ethers";
import { BN254_R } from "../shield/pool";

export interface Position {
  /** Microdegrees: 37.7749° is 37_774_900. */
  lat: number;
  lon: number;
}

export const encLat = (lat: number): bigint => BigInt(lat) + 90_000_000n;
export const encLon = (lon: number): bigint => BigInt(lon) + 180_000_000n;

export const positionCommit = (p: Position, salt: bigint): bigint =>
  poseidon3([encLat(p.lat), encLon(p.lon), salt]);

/** The dropoff proof's nullifier: one settlement per drop salt and order. */
export const dropNullifier = (salt: bigint, orderId: bigint): bigint =>
  poseidon2([salt, orderId]);

export const b32 = (x: bigint): string =>
  "0x" + x.toString(16).padStart(64, "0");

/** A fresh field element for a salt. */
export const randomSalt = (): bigint =>
  toBigInt(crypto.getRandomValues(new Uint8Array(31))) % BN254_R;

/** Degrees as a decimal string to microdegrees, e.g. "37.7749" → 37_774_900. */
export function parseDegrees(s: string): number | null {
  const m = s.trim().match(/^(-?)(\d{1,3})(?:\.(\d{0,6}))?$/);
  if (!m) return null;
  const whole = Number(m[2]);
  const frac = (m[3] ?? "").padEnd(6, "0");
  const v = whole * 1_000_000 + Number(frac);
  return m[1] === "-" ? -v : v;
}

export const formatDegrees = (micro: number): string =>
  (micro / 1_000_000).toFixed(6);

/** Metres between two positions, flat-earth at these distances. */
export function metresBetween(a: Position, b: Position): number {
  const dLat = ((a.lat - b.lat) / 1e6) * 111_320;
  const dLon =
    ((a.lon - b.lon) / 1e6) *
    111_320 *
    Math.cos((a.lat / 1e6) * (Math.PI / 180));
  return Math.round(Math.hypot(dLat, dLon));
}
