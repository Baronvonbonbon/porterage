/** Planck (10 decimals, Substrate side) as PAS, to 4 places. */
export function pas(planck: bigint): string {
  const whole = planck / 10_000_000_000n;
  const frac = (planck % 10_000_000_000n)
    .toString()
    .padStart(10, "0")
    .slice(0, 4);
  return `${whole}.${frac} PAS`;
}

/** Wei (18 decimals, EVM side) as PAS, to 4 places. */
export function pasWei(wei: bigint): string {
  return pas(wei / 100_000_000n);
}

/**
 * A distance, the same way everywhere. Three screens had grown their own
 * version of this — `far()` in Jobs, `KM()` in Here, `fromHere()` in Ordering —
 * and they disagreed about when to switch to kilometres.
 */
export function metres(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;
}

export function short(a: string): string {
  return a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
