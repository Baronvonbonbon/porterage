// The pool's inserts in one block, read from Substrate's System.Events: the
// only place a deposit sent as a Substrate Revive.call shows up (pool.ts).
// The Paseo RPC answers for old blocks, so this works at any depth.

import { hexlify } from "ethers";
import type { PolkadotClient } from "polkadot-api";
import { DEPOSIT_TOPIC, NEW_COMMITMENT_TOPIC, type BlockInserts } from "./pool";

const hex = (v: unknown): string =>
  typeof v === "string" ? v.toLowerCase() : v instanceof Uint8Array ? hexlify(v) : hexlify((v as { asBytes(): Uint8Array }).asBytes());

interface EventRecord {
  event: { type: string; value: { type: string; value: { contract: unknown; data: unknown; topics: unknown[] } } };
}

export function poolInserts(client: PolkadotClient, pool: string): BlockInserts {
  const want = pool.toLowerCase();
  const topics = [DEPOSIT_TOPIC, NEW_COMMITMENT_TOPIC];
  return async (block) => {
    const hash = await client._request<string>("chain_getBlockHash", [block]);
    if (!hash) throw new Error(`no block ${block}`);
    const events = (await client.getUnsafeApi().query.System.Events.getValue({ at: hash })) as EventRecord[];
    const out: bigint[] = [];
    for (const { event } of events) {
      if (event.type !== "Revive" || event.value.type !== "ContractEmitted") continue;
      const e = event.value.value;
      if (hex(e.contract) !== want || !topics.includes(hex(e.topics[0]))) continue;
      out.push(BigInt(hex(e.data).slice(0, 66)));
    }
    return out;
  };
}
