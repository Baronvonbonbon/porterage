// Ratings (docs/PLAN.md §4 step 6).
//
// Only the customer of a Delivered order can rate it, once, and it rates the
// driver and the venue separately — either can be skipped with a zero. The
// contract checks all of that, so this is a thin wrapper over it.
//
// It's sent by the order's own burner, like everything else the customer does,
// so a rating says "the account that placed order #7 gave four stars" and
// nothing about who that is. The cost is that reputation can't be tied back to
// a person — which is the trade this whole design keeps making.

import { Contract, type Wallet } from "ethers";
import { ABI, addressOf, read, writable } from "../contracts";

export interface Rating {
  /** Average in hundredths of a star: 437 is 4.37★. */
  avgX100: number;
  count: number;
}

const asRating = (r: [bigint, bigint]): Rating => ({
  avgX100: Number(r[0]),
  count: Number(r[1]),
});

export const driverRating = async (driver: string): Promise<Rating> =>
  asRating(await read("ratings").driverRating(driver));

export const venueRating = async (venueId: bigint): Promise<Rating> =>
  asRating(await read("ratings").venueRating(venueId));

export const wasRated = (orderId: bigint): Promise<boolean> =>
  read("ratings").rated(orderId);

/** Rate a delivered order. Stars are 1–5, or 0 to leave that side unrated. */
export async function rate(
  burner: Wallet,
  orderId: bigint,
  driverStars: number,
  venueStars: number
): Promise<void> {
  if (!driverStars && !venueStars) throw new Error("nothing to rate");
  const ratings = new Contract(
    addressOf("ratings"),
    ABI.ratings.fragments as never,
    writable(burner)
  );
  await (await ratings.rate(orderId, driverStars, venueStars)).wait();
}

/** "4.4★ from 7" — or an honest blank for someone nobody has rated yet. */
export const ratingText = (r: Rating | null): string =>
  !r || r.count === 0
    ? "not rated yet"
    : `${(r.avgX100 / 100).toFixed(1)}★ from ${r.count}`;
