// Telling someone something happened, through the host (docs/PLAN.md §6.1).
//
// The app has no Push API, so this is the host's own notification surface
// (RFC-0019): `push({ text })` now, or with a `scheduledAt` for later.
//
// WHAT THE TEXT MAY SAY, and why it says so little: the notification goes
// through the host, so the host sees it, and the host knows exactly which
// person it is delivering to. "Your order #7 has a bid of 1.5 PAS" would hand
// over the one link this design spends everything else avoiding — which real
// person is behind which burner. So a notification names a KIND of event and
// nothing else: no order, no amount, no address, no venue. Whoever taps it
// opens the app and sees the detail there, where it is nobody else's business.
//
// Each kind fires once per order per run. Without that, the polling that the
// order screens already do would push the same line every few seconds.

import { getNotificationManager } from "@parity/product-sdk-host";
import { inHost } from "./host";

export type Happening =
  | "bid"
  | "assigned"
  | "picked-up"
  | "at-the-door"
  | "delivered"
  | "basket"
  | "message"
  | "disputed";

/** Deliberately incurious. See the note above. */
const WORDS: Record<Happening, string> = {
  bid: "A driver has bid on your order.",
  assigned: "You have a new job.",
  "picked-up": "Your order has been collected.",
  "at-the-door": "Your delivery is at the door.",
  delivered: "Your order was delivered.",
  basket: "A new order came in.",
  message: "You have a message.",
  disputed: "An order you're part of is disputed.",
};

const told = new Set<string>();

let manager: Promise<
  Awaited<ReturnType<typeof getNotificationManager>>
> | null = null;
const notifications = () =>
  (manager ??= getNotificationManager().catch(() => null));

export async function notificationsWork(): Promise<boolean> {
  return (await inHost()) && !!(await notifications());
}

/**
 * Say that something happened, once per `about` per run. `about` never reaches
 * the host — it only decides whether this device has already said it.
 */
export async function tell(
  what: Happening,
  about: string | bigint = ""
): Promise<void> {
  const once = `${what}:${about}`;
  if (told.has(once)) return;
  told.add(once);
  try {
    const n = await notifications();
    if (!n) return;
    await n.push({ text: WORDS[what] });
  } catch {
    // A notification is a courtesy. The host refusing one — no permission, its
    // schedule full — must never stop the thing that happened.
    told.delete(once);
  }
}

/** For tests, and for a screen that wants to say something twice on purpose. */
export function _forget(): void {
  told.clear();
}

/**
 * A notification timed to land after the app is put away, for the phone probe
 * (probe.ts). It carries no order and no amount — the discipline above is not
 * suspended for a measurement, and the text is about the probe itself.
 *
 * Returns how long the host took to accept it, or null if it wouldn't.
 */
export async function scheduleProbe(inSeconds: number): Promise<number | null> {
  const n = await notifications();
  if (!n) return null;
  const started = Date.now();
  await n.push({
    text: "Porterage: this is the notification probe.",
    // Milliseconds, and a bigint on the wire — a number is refused by the type.
    scheduledAt: BigInt(Date.now() + inSeconds * 1000),
  });
  return Date.now() - started;
}
