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

/**
 * A stretch of time as someone would say it: "12 minutes", "1 h 5 m". Never
 * seconds beyond a minute — a countdown ticking down by the second reads as an
 * emergency, and this one is measured in tens of minutes.
 */
export function countdown(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} m` : `${hours} h`;
}
