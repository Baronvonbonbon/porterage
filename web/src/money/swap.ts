// Swapping on Asset Hub's own asset-conversion DEX (docs/PLAN.md §5.1).
//
// The pool is keyed by XCM location, so PAS is {parents: 1, Here} and an asset
// is {parents: 0, X2[PalletInstance(50), GeneralIndex(id)]}.
//
// A host account signs Substrate transactions, so it calls the pallet directly:
// no XCM program and no precompile. (A burner holds an Ethereum key and can't;
// when escrow lands in a token, it will need the XCM precompile's ExchangeAsset,
// as FARE's venue-node/swap.mjs does.)

import { substrate } from "../hostchain";
import type { Token } from "./tokens";

interface Junction {
  type: string;
  value?: unknown;
}
export interface Location {
  parents: number;
  interior: Junction;
}

export const PAS_LOCATION: Location = {
  parents: 1,
  interior: { type: "Here", value: undefined },
};
export const locationOf = (id: number): Location => ({
  parents: 0,
  interior: {
    type: "X2",
    value: [
      { type: "PalletInstance", value: 50 },
      { type: "GeneralIndex", value: BigInt(id) },
    ],
  },
});

const api = () => substrate().getUnsafeApi();

/** What `amountIn` of `from` buys of `to`, after the pool's fee. Null when there's no liquidity. */
export async function quote(
  from: Location,
  to: Location,
  amountIn: bigint
): Promise<bigint | null> {
  const out =
    (await api().apis.AssetConversionApi.quote_price_exact_tokens_for_tokens(
      from,
      to,
      amountIn,
      true
    )) as bigint | undefined;
  return out && out > 0n ? out : null;
}

/** What it costs in `from` to buy exactly `amountOut` of `to`. */
export async function quoteForExact(
  from: Location,
  to: Location,
  amountOut: bigint
): Promise<bigint | null> {
  const out =
    (await api().apis.AssetConversionApi.quote_price_tokens_for_exact_tokens(
      from,
      to,
      amountOut,
      true
    )) as bigint | undefined;
  return out && out > 0n ? out : null;
}

/** PAS (planck) for `amount` of a token, and the other way round. */
export const quoteToPas = (token: Token, amount: bigint) =>
  quote(locationOf(token.id), PAS_LOCATION, amount);
export const quoteFromPas = (token: Token, planck: bigint) =>
  quote(PAS_LOCATION, locationOf(token.id), planck);

/** How much of `token` a balance is worth, for showing a price. */
export async function pasPerToken(token: Token): Promise<bigint | null> {
  return quoteToPas(token, 10n ** BigInt(token.decimals));
}

export interface SwapPlan {
  from: Location;
  to: Location;
  amountIn: bigint;
  /** The quote, before slippage. */
  quoted: bigint;
  /** What the swap must deliver at least, or it fails rather than filling badly. */
  minOut: bigint;
}

/** Plan a swap of `amountIn`, refusing to go ahead below `slippageBps` of the quote. */
export async function planSwap(
  from: Location,
  to: Location,
  amountIn: bigint,
  slippageBps = 100n
): Promise<SwapPlan> {
  const quoted = await quote(from, to, amountIn);
  if (quoted === null)
    throw new Error("that pair has no liquidity on Asset Hub right now");
  return {
    from,
    to,
    amountIn,
    quoted,
    minOut: (quoted * (10_000n - slippageBps)) / 10_000n,
  };
}

/** The pallet call, for sending on its own or inside a batch (one tap either way). */
export function swapCall(plan: SwapPlan, sendTo: string) {
  return api().tx.AssetConversion.swap_exact_tokens_for_tokens({
    path: [plan.from, plan.to],
    amount_in: plan.amountIn,
    amount_out_min: plan.minOut,
    send_to: sendTo,
    keep_alive: true,
  });
}

/** An account's balance of an asset, in its smallest units. */
export async function tokenBalance(
  token: Token,
  address: string
): Promise<bigint> {
  const acct = (await api().query.Assets.Account.getValue(
    token.id,
    address
  )) as { balance: bigint } | undefined;
  return acct?.balance ?? 0n;
}

/** An asset's minimum balance: an account holding less than this can't exist. */
export async function minBalance(token: Token): Promise<bigint> {
  const asset = (await api().query.Assets.Asset.getValue(token.id)) as
    | { min_balance: bigint }
    | undefined;
  return asset?.min_balance ?? 0n;
}

/**
 * What can actually be swapped away: the balance less the asset's minimum.
 * Spending the lot is refused as `Token(NotExpendable)` — the account may not be
 * emptied out of existence (Paseo, 2026-09-20).
 */
export async function spendableToken(
  token: Token,
  address: string
): Promise<bigint> {
  const [balance, min] = await Promise.all([
    tokenBalance(token, address),
    minBalance(token),
  ]);
  return balance > min ? balance - min : 0n;
}
