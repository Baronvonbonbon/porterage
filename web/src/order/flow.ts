// Placing an order (docs/PLAN.md §4 step 1), end to end from the customer's side.
//
//   fund a fresh account from the private balance   (shield/fund.ts)
//   commit to the drop position and create the order
//   publish the account's key so bidders can reach it
//
// The drop's coordinates never leave the phone: the order carries only
// Poseidon(lat, lon, salt), and the salt is kept here to open it at dropoff.

import type { Wallet } from "ethers";
import { burner as burnerKey } from "../keys";
import { addressOf, ethProvider } from "../contracts";
import { fundBurner, type FundStage } from "../shield/fund";
import { allOrders, rememberOrder, type OrderRecord } from "../shield/notes";
import { announceOrder } from "./bids";
import { sendBasket, venueTopic } from "./kitchen";
import { introduce } from "./chat";
import { b32, positionCommit, randomSalt, type Position } from "./geo";
import { ORDER_GAS_RESERVE, createOrder, escrowFor } from "./orders";

export type PlaceStage =
  | FundStage
  | "creating"
  /** The chain had no room this block and the order is being placed again. */
  | "crowded"
  | "announcing"
  | "placed";

export interface OrderPlan {
  venueId: bigint;
  drop: Position;
  /** What was picked from the menu, and the counter's key to seal it to. */
  basket?: { items: Map<string, number>; counterKey?: string };
  /** Goods value owed to the venue. */
  orderValue: bigint;
  tip: bigint;
  /** The most the auction may cost. */
  maxFare: bigint;
}

/** What the fresh account needs: escrow now, the fare when a bid is accepted, and gas. */
export const fundingFor = (p: OrderPlan): bigint =>
  escrowFor({ ...p, dropCommit: "0x" }) + p.maxFare + ORDER_GAS_RESERVE;

export async function placeOrder(
  plan: OrderPlan,
  onStage: (s: PlaceStage) => void
): Promise<{ orderId: bigint; burner: Wallet; record: OrderRecord }> {
  const funded = await fundBurner(fundingFor(plan), onStage);
  const burner = funded.burner.connect(ethProvider());

  onStage("creating");
  const salt = randomSalt();
  const orderId = await createOrder(
    burner,
    {
      venueId: plan.venueId,
      dropCommit: b32(positionCommit(plan.drop, salt)),
      orderValue: plan.orderValue,
      tip: plan.tip,
      maxFare: plan.maxFare,
    },
    // Say so rather than sit silent: a refused block costs a few seconds and
    // the person is watching a spinner that would otherwise not move.
    { onRetry: () => onStage("crowded") }
  );

  const record: OrderRecord = {
    id: orderId.toString(),
    // Stamped now, and used for the life of this order. The contract can be
    // upgraded out from under a delivery that is already in flight; this order
    // finishes where it started.
    at: addressOf("orders"),
    burner: funded.burnerIndex,
    lat: plan.drop.lat,
    lon: plan.drop.lon,
    salt: salt.toString(),
    placedAt: Date.now(),
  };
  await rememberOrder(record);

  onStage("announcing");
  // From here the order exists and its money is escrowed, so nothing below may
  // throw: a statement that failed would otherwise leave someone looking at an
  // error while an order sits on-chain, funded, with no way to be bid on.
  // Whatever fails is written down and retried when the order is opened.
  const owes: ("announce" | "basket")[] = [];
  const keep =
    plan.basket?.counterKey && plan.basket.items.size
      ? {
          items: [...plan.basket.items].filter(([, n]) => n > 0) as [
            string,
            number
          ][],
          counterKey: plan.basket.counterKey,
          venueId: plan.venueId.toString(),
        }
      : undefined;

  try {
    await announceOrder(burner, orderId);
  } catch {
    owes.push("announce");
  }

  if (keep) {
    try {
      await sendBasket(plan.venueId, keep.counterKey, {
        orderId,
        items: new Map(keep.items),
      });
      // And the key to answer on: a basket is sealed with a throwaway key, so
      // without this the kitchen could read the order but not reply to it.
      await introduce(
        burner,
        keep.counterKey,
        venueTopic(plan.venueId),
        orderId,
        "customer"
      );
    } catch {
      owes.push("basket");
    }
  }

  if (owes.length || keep)
    await rememberOrder({ ...record, basket: keep, owes });

  onStage("placed");
  return { orderId, burner, record };
}

/** The account that placed one of this device's orders. */
export async function orderBurner(rec: OrderRecord): Promise<Wallet> {
  return (await burnerKey(rec.burner)).connect(ethProvider());
}

/**
 * Try again whatever an order still owes. Called when its screen opens, which
 * is the moment the device is awake and someone is watching.
 */
export async function settleDebts(
  record: OrderRecord,
  burner: Wallet
): Promise<OrderRecord> {
  if (!record.owes?.length) return record;
  const orderId = BigInt(record.id);
  const still: ("announce" | "basket")[] = [];

  for (const owed of record.owes) {
    try {
      if (owed === "announce") {
        await announceOrder(burner, orderId);
      } else if (record.basket) {
        await sendBasket(
          BigInt(record.basket.venueId),
          record.basket.counterKey,
          {
            orderId,
            items: new Map(record.basket.items),
          }
        );
        await introduce(
          burner,
          record.basket.counterKey,
          venueTopic(BigInt(record.basket.venueId)),
          orderId,
          "customer"
        );
      }
    } catch {
      still.push(owed);
    }
  }

  const settled = { ...record, owes: still };
  await rememberOrder(settled);
  return settled;
}

export const myOrders = allOrders;
