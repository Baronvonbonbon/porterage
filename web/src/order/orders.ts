// Orders, as the app reads and writes them (docs/PLAN.md §4).
//
// A customer acts from a fresh burner, funded privately (shield/fund.ts), so
// every order transaction is an ordinary Ethereum transaction from an account
// that has no history and no link to the customer. Drivers act from their
// session key, which needs no taps. Neither path asks the host to sign.

import { Contract, type Wallet } from "ethers";
import {
  ABI,
  addressOf,
  ethProvider,
  read,
  readAt,
  writable,
} from "../contracts";
import { send, type SendOptions } from "../send";

export const Status = {
  Open: 1,
  Assigned: 2,
  PickedUp: 3,
  Delivered: 4,
  Cancelled: 5,
  Disputed: 6,
} as const;
export type StatusName = keyof typeof Status;

export const statusName = (n: number): StatusName =>
  (Object.keys(Status) as StatusName[]).find((k) => Status[k] === n) ?? "Open";

export interface Order {
  id: bigint;
  customer: string;
  venueId: bigint;
  status: number;
  driver: string;
  orderValue: bigint;
  tip: bigint;
  fare: bigint;
  maxFare: bigint;
  dropCommit: string;
  createdAt: bigint;
  token: string;
}

/**
 * Read one order.
 *
 * `at` names the deployment it belongs to. Pass `record.at` for a stored
 * order: ids are per-contract, so the same id on the current contract is a
 * different order (see `readAt`).
 */
export async function orderOf(id: bigint, at?: string): Promise<Order> {
  const o = await readAt("orders", at).orders(id);
  return {
    id,
    customer: o.customer,
    venueId: o.venueId,
    status: Number(o.status),
    driver: o.driver,
    orderValue: o.orderValue,
    tip: o.tip,
    fare: o.fare,
    maxFare: o.maxFare,
    dropCommit: o.dropCommit,
    createdAt: o.createdAt,
    token: o.token,
  };
}

/** The most recent orders, newest first. Reads by id, so no event log is needed. */
export async function recentOrders(limit = 20): Promise<Order[]> {
  const orders = read("orders");
  const next = Number(await orders.nextOrderId());
  const ids: bigint[] = [];
  for (let id = next - 1; id >= 1 && ids.length < limit; id--)
    ids.push(BigInt(id));
  return Promise.all(ids.map((id) => orderOf(id)));
}

export interface NewOrder {
  venueId: bigint;
  dropCommit: string;
  orderValue: bigint;
  tip: bigint;
  maxFare: bigint;
  pickupWindowSecs?: bigint;
  deliveryWindowSecs?: bigint;
}

const orderContract = (signer: Wallet, at?: string) =>
  new Contract(at || addressOf("orders"), ABI.orders.fragments as never, writable(signer));

/** What a burner must hold to place this order: the escrow plus room for gas. */
export const escrowFor = (o: NewOrder): bigint => o.orderValue + o.tip;

/**
 * Create an order from the burner. Returns the new order's id.
 *
 * The id comes out of the receipt, not from reading `nextOrderId` beforehand.
 * Two customers ordering at the same moment both read the same next id and one
 * of them would carry the other's order around for the rest of the flow; a
 * hundred-order fleet run hit exactly that and failed later with
 * "not-customer". The log says which order this transaction actually made.
 */
export async function createOrder(
  burner: Wallet,
  o: NewOrder,
  opts?: SendOptions
): Promise<bigint> {
  const orders = orderContract(burner);
  const receipt = await send(
    () =>
      orders.createOrder(
        o.venueId,
        o.dropCommit,
        o.orderValue,
        o.tip,
        o.maxFare,
        o.pickupWindowSecs ?? 0n,
        o.deliveryWindowSecs ?? 0n,
        { value: escrowFor(o) }
      ),
    opts
  );
  for (const log of receipt.logs) {
    const parsed = orders.interface.parseLog({
      topics: [...log.topics],
      data: log.data,
    });
    if (parsed?.name === "OrderCreated") return parsed.args[0] as bigint;
  }
  throw new Error("the order was placed but the chain named no id for it");
}

/** Accept a bid, paying the fare into escrow. From the burner: no taps. */
export async function acceptBid(
  burner: Wallet,
  orderId: bigint,
  driver: string,
  amount: bigint,
  salt: string,
  at?: string,
  opts?: SendOptions
): Promise<void> {
  await send(
    () =>
      orderContract(burner, at).acceptSealedBid(orderId, driver, amount, salt, {
        value: amount,
      }),
    opts
  );
}

/** Cancel an order nobody has taken, refunding the escrow to the burner. */
export async function cancelOrder(
  burner: Wallet,
  orderId: bigint,
  at?: string,
  opts?: SendOptions
): Promise<void> {
  await send(() => orderContract(burner, at).cancelOpen(orderId), opts);
}

/**
 * Drop a driver that never turned up and put the order back out for bids.
 * Only after the pickup deadline; before that `cancelAssigned` is the path and
 * it pays the driver the agreed compensation for being dropped.
 *
 * The order survives: the goods escrow never moves, so nothing has to be
 * shielded and placed again. Only the fare comes back, because a fare is a
 * price agreed with one driver.
 */
export async function reopenTimedOut(
  burner: Wallet,
  orderId: bigint,
  at?: string,
  opts?: SendOptions
): Promise<void> {
  await send(() => orderContract(burner, at).reopenTimedOut(orderId), opts);
}

/** When the driver has to have collected by. Zero when there is no driver. */
export async function pickupDeadline(
  orderId: bigint,
  at?: string
): Promise<number> {
  const [pickup] = await readAt("orders", at).deadlinesOf(orderId);
  return Number(pickup);
}

/** Gas a burner should keep back for the order's own transactions, at Paseo prices. */
export const ORDER_GAS_RESERVE = 10n ** 18n; // 1 PAS

export const provider = ethProvider;
