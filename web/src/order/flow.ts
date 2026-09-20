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
import { ethProvider } from "../contracts";
import { DEFAULT_TIP, fundBurner, type FundStage } from "../shield/fund";
import { allOrders, rememberOrder, type OrderRecord } from "../shield/notes";
import { announceOrder } from "./bids";
import { sendBasket, venueTopic } from "./kitchen";
import { introduce } from "./chat";
import { b32, positionCommit, randomSalt, type Position } from "./geo";
import { ORDER_GAS_RESERVE, createOrder, escrowFor } from "./orders";

export type PlaceStage = FundStage | "creating" | "announcing" | "placed";

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
  const funded = await fundBurner(fundingFor(plan), onStage, DEFAULT_TIP);
  const burner = funded.burner.connect(ethProvider());

  onStage("creating");
  const salt = randomSalt();
  const orderId = await createOrder(burner, {
    venueId: plan.venueId,
    dropCommit: b32(positionCommit(plan.drop, salt)),
    orderValue: plan.orderValue,
    tip: plan.tip,
    maxFare: plan.maxFare,
  });

  const record: OrderRecord = {
    id: orderId.toString(),
    burner: funded.burnerIndex,
    lat: plan.drop.lat,
    lon: plan.drop.lon,
    salt: salt.toString(),
    placedAt: Date.now(),
  };
  await rememberOrder(record);

  onStage("announcing");
  await announceOrder(burner, orderId);
  // The counter needs to know what to make. Sealed to its key, on the venue's topic.
  if (plan.basket?.counterKey && plan.basket.items.size) {
    await sendBasket(plan.venueId, plan.basket.counterKey, {
      orderId,
      items: plan.basket.items,
    });
    // And the key to answer on: a basket is sealed with a throwaway key, so
    // without this the kitchen could read the order but not reply to it.
    await introduce(
      burner,
      plan.basket.counterKey,
      venueTopic(plan.venueId),
      orderId,
      "customer"
    );
  }
  onStage("placed");
  return { orderId, burner, record };
}

/** The account that placed one of this device's orders. */
export async function orderBurner(rec: OrderRecord): Promise<Wallet> {
  return (await burnerKey(rec.burner)).connect(ethProvider());
}

export const myOrders = allOrders;
