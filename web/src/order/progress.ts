// What is happening, and what happens next (docs/IMPROVEMENTS.md, smaller things).
//
// An order's status is a number the contract keeps, and the screens were
// showing it as a word — "Assigned" — which says what state a machine is in,
// not what the person waiting should expect. These are the sentences instead.
//
// Three parties see the same order differently: the customer waits, the driver
// acts, the counter makes. So the sentence depends on who is reading it.

import { Status, type Order } from "./orders";

export type Party = "customer" | "driver" | "venue";

export interface Progress {
  /** One line, in the present tense, about this order right now. */
  now: string;
  /** What the reader does next, when there is something. */
  next?: string;
  /** The order is over, one way or another. */
  done?: boolean;
}

export function progressOf(order: Pick<Order, "status">, who: Party): Progress {
  switch (order.status) {
    case Status.Open:
      return who === "customer"
        ? {
            now: "Waiting for drivers to bid.",
            next: "Take a bid when one you like arrives.",
          }
        : {
            now: "Open for bids.",
            next: who === "driver" ? "Bid on it." : undefined,
          };

    case Status.Assigned:
      return who === "customer"
        ? {
            now: "A driver has it.",
            next: "It collects from the counter next.",
          }
        : who === "driver"
        ? {
            now: "Yours to collect.",
            next: "Scan the counter's code when you're there.",
          }
        : {
            now: "A driver is on the way to collect.",
            next: "Have it ready, then show the driver your code.",
          };

    case Status.PickedUp:
      return who === "customer"
        ? {
            now: "Collected, and on its way.",
            next: "Show the driver your code at the door.",
          }
        : who === "driver"
        ? { now: "You have it.", next: "Scan the customer's code at the door." }
        : { now: "Collected. Your part is done.", done: true };

    case Status.Delivered:
      return who === "driver"
        ? { now: "Delivered, and you've been paid.", done: true }
        : {
            now: "Delivered and paid.",
            next: who === "customer" ? "Rate it, if you like." : undefined,
            done: true,
          };

    case Status.Cancelled:
      return { now: "Cancelled. The escrow went back.", done: true };

    case Status.Disputed:
      return {
        now: "Disputed. The money is held until an arbiter rules.",
        done: false,
      };

    default:
      // Resolved is 7 in the contract, past the statuses this app creates.
      return { now: "Settled by an arbiter.", done: true };
  }
}
