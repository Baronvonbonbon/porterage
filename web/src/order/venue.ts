// Venues (docs/PLAN.md §4 step 3).
//
// A venue registers from the operator's own account — one tap — and names a
// SIGNER, which is this phone's session key. From then on the counter signs
// pickups with no taps at all: the QR the driver scans is signed by the session
// key, and the venue's registered pin is what both sides attest to.

import { Wallet } from "ethers";
import { ABI, addressOf, read } from "../contracts";
import { hostCall } from "../hostchain";
import type { Position } from "./geo";

export interface Venue {
  id: bigint;
  operator: string;
  signer: string;
  payout: string;
  at: Position;
  active: boolean;
  /** Completed pickups. The contract's own count, and the closest thing
   *  to takings that is public — it says how many, never how much. */
  pickups: number;
  metadataURI: string;
}

export async function venueOf(id: bigint): Promise<Venue> {
  const v = await read("venues").venues(id);
  return {
    id,
    operator: v.operator,
    signer: v.signer,
    payout: v.payout,
    at: { lat: Number(v.lat), lon: Number(v.lon) },
    active: v.active,
    pickups: Number(v.pickups),
    metadataURI: v.metadataURI,
  };
}

/**
 * Venues registered so far, newest first. Read by id, so no event log is
 * needed — and the log is not trustworthy here anyway: venue #6 is live on
 * chain with its `VenueRegistered` missing from the RPC's index.
 *
 * `limit` counts venues KEPT, not ids looked at, and closed ones are skipped
 * rather than counted. It used to cap the ids visited instead, which meant a
 * venue could be pushed out of existence by newer ones: twenty test venues
 * from the fleet harness took ids 16–35, and the only real venue on the chain,
 * #6, stopped appearing for anybody. A shop that cannot be found by its
 * customers is indistinguishable from a shop that is gone.
 *
 * This walks every id until it has enough, which is honest at a few hundred
 * venues and wrong at a few thousand — at that point the answer is an index
 * (by area, on chain or beside it), not a bigger number here.
 */
export async function allVenues(
  limit = 20,
  { closed = false }: { closed?: boolean } = {}
): Promise<Venue[]> {
  const next = Number(await read("venues").nextVenueId());
  const out: Venue[] = [];
  // A page at a time, read together: one round trip per id in sequence is
  // half a minute of staring at an empty grid on a phone.
  const PAGE = 12;
  for (let top = next - 1; top >= 1 && out.length < limit; top -= PAGE) {
    const ids: bigint[] = [];
    for (let id = top; id > top - PAGE && id >= 1; id--) ids.push(BigInt(id));
    for (const v of await Promise.all(ids.map(venueOf)))
      if ((v.active || closed) && out.length < limit) out.push(v);
  }
  return out;
}

/** The venue ids this account operates. */
export async function myVenues(operator: string): Promise<Venue[]> {
  const venues = read("venues");
  const count = Number(await venues.venueCountOf(operator));
  const ids: bigint[] = [];
  for (let i = 0; i < count; i++)
    ids.push(await venues.venuesByOperator(operator, i));
  return Promise.all(ids.map(venueOf));
}

/** Register a venue at `at`, signing pickups with `signer`. One tap. */
export async function registerVenue(
  at: Position,
  signer: Wallet,
  metadataURI = ""
): Promise<{ block: number }> {
  return hostCall(
    addressOf("venues"),
    ABI.venues.encodeFunctionData("registerVenue", [
      at.lat,
      at.lon,
      signer.address,
      signer.address,
      metadataURI,
    ])
  );
}

/** Point an existing venue at this phone's session key. One tap. */
export async function setVenueSigner(
  id: bigint,
  signer: Wallet
): Promise<{ block: number }> {
  return hostCall(
    addressOf("venues"),
    ABI.venues.encodeFunctionData("setSigner", [id, signer.address])
  );
}
