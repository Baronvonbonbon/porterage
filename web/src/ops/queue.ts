// The operations queue (docs/PLAN.md §6, Phase 6).
//
// Everything an arbiter needs to rule, read straight from the contracts: the
// open disputes, the order each one is about, and what the driver's record
// looks like. There is no index and no server — disputes are numbered from 1,
// so the queue is a walk backwards from the newest.
//
// Reads only. Signing a ruling is views/Ops.tsx and tools/ops.ts, and both go
// through ops/ruling.ts for the arithmetic first.

import { read } from "../contracts";
import { statusName, type StatusName } from "../order/orders";

export interface QueueRow {
  disputeId: bigint;
  orderId: bigint;
  opener: string;
  bond: bigint;
  /** 1 open, 2 resolved. */
  status: number;
  evidenceURI: string;

  customer: string;
  driver: string;
  venueId: bigint;
  escrow: bigint;
  orderValue: bigint;
  fare: bigint;
  orderStatus: StatusName;

  /** The driver's stake, and its record, for judging a slash. */
  driverStake: bigint;
  delivered: number;
  failed: number;
  /** When each party committed evidence, 0 for never. */
  evidence: { party: string; key: string; at: number }[];
}

const ZERO = `0x${"0".repeat(40)}`;

/** One dispute with everything joined onto it. */
export async function rowFor(disputeId: bigint): Promise<QueueRow | null> {
  const disputes = read("disputes");
  const d = await disputes.disputes(disputeId);
  if (Number(d.status) === 0) return null;

  const orderId: bigint = d.orderId;
  const o = await read("orders").orders(orderId);
  const driver: string = o.driver;
  const record = driver !== ZERO ? await read("drivers").drivers(driver) : null;

  const evidence = [];
  for (const party of [o.customer, driver].filter((p) => p !== ZERO)) {
    const e = await disputes.evidenceOf(orderId, party);
    if (e[0] && e[0] !== `0x${"0".repeat(64)}`) {
      evidence.push({ party, key: e[0] as string, at: Number(e[1]) });
    }
  }

  return {
    disputeId,
    orderId,
    opener: d.opener,
    bond: d.bond,
    status: Number(d.status),
    evidenceURI: d.evidenceURI,
    customer: o.customer,
    driver,
    venueId: o.venueId,
    escrow: o.escrow,
    orderValue: o.orderValue,
    fare: o.fare,
    orderStatus: statusName(Number(o.status)),
    driverStake: record ? record.stake : 0n,
    delivered: record ? Number(record.delivered) : 0,
    failed: record ? Number(record.failed) : 0,
    evidence,
  };
}

/** The queue, newest first. `openOnly` is what an arbiter usually wants. */
export async function queue(limit = 20, openOnly = true): Promise<QueueRow[]> {
  const next = Number(await read("disputes").nextDisputeId());
  const rows: QueueRow[] = [];
  for (let id = next - 1; id >= 1 && rows.length < limit; id--) {
    const row = await rowFor(BigInt(id));
    if (row && (!openOnly || row.status === 1)) rows.push(row);
  }
  return rows;
}

/** Which categories the pause registry is holding shut, if any. */
export async function paused(categories = 8): Promise<number[]> {
  const registry = read("pauseRegistry");
  const shut: number[] = [];
  for (let c = 0; c < categories; c++)
    if (await registry.isPaused(c)) shut.push(c);
  return shut;
}
