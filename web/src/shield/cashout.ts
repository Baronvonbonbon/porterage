// Taking money out of the shield and keeping it.
//
// Everyone in Porterage can already put money in and get paid; until now only
// the customer could take anything out, and only by spending it on an order.
// A driver could shield a week of fares and then do nothing with them.
//
// WHAT COMES OUT, AND WHAT THAT COSTS.
//
// A cash-out is the same withdrawal an order uses: a note is spent, a proof
// pays a FRESH account, and a stranger submits it. What an observer learns from
// that is only "some unspent note paid out to this new address" — the anonymity
// set is every unspent note in the pool, so nothing says it was fares rather
// than a customer's leftover funds, or whose fares.
//
// The account it lands in is unlinked and it STAYS unlinked. That is the whole
// point of stopping here, and it is why `sendOnward` is a separate, deliberate
// call rather than the last line of this one: the moment that account pays an
// address someone can name, an observer sees that address receive a known
// amount at a known time. The private half is automatic; the half that spends
// privacy is a decision the person makes with the cost written next to it.

import { formatEther, type Wallet } from "ethers";
import { ethProvider } from "../contracts";
import { burner as burnerKey } from "../keys";
import {
  allCashOuts,
  markCashOutSent,
  rememberCashOut,
  type CashOutRecord,
} from "./notes";
import { fundBurner, type FundStage } from "./fund";

export type { CashOutRecord };
export type CashOutStage = FundStage;

/**
 * Take `amount` out of the shield into a fresh account this device keeps.
 *
 * It is `fundBurner` underneath — the identical machinery an order uses, which
 * is the point: a cash-out that took a different path would stand out from the
 * order withdrawals it is meant to hide among.
 */
export async function cashOut(
  amount: bigint,
  onStage: (s: CashOutStage) => void
): Promise<CashOutRecord> {
  const funded = await fundBurner(amount, onStage);
  const record: CashOutRecord = {
    burner: funded.burnerIndex,
    address: funded.burner.address,
    at: Date.now(),
  };
  await rememberCashOut(record);
  return record;
}

/** What each kept account is holding right now. */
export async function cashOutBalances(): Promise<
  Array<CashOutRecord & { balance: bigint }>
> {
  const provider = ethProvider();
  return Promise.all(
    (await allCashOuts()).map(async (r) => ({
      ...r,
      balance: await provider.getBalance(r.address).catch(() => 0n),
    }))
  );
}

/** Gas kept back so the send itself can be paid for. */
const GAS_RESERVE = 2n * 10n ** 16n; // 0.02 PAS

/** What can actually be sent on, after leaving room for the transfer's gas. */
export const sendableOf = (balance: bigint): bigint =>
  balance > GAS_RESERVE ? balance - GAS_RESERVE : 0n;

/**
 * Send a kept account's balance to an address the person names — their host
 * account, or any wallet they control.
 *
 * THIS IS THE STEP THAT COSTS PRIVACY and the caller is expected to have said
 * so. Everything before it hides where the money came from; this publishes that
 * `to` received this much, now. It cannot be otherwise on a transparent chain,
 * and pretending it can would be worse than saying it.
 */
export async function sendOnward(
  record: CashOutRecord,
  to: string
): Promise<{ hash: string; sent: bigint }> {
  const key: Wallet = (await burnerKey(record.burner)).connect(ethProvider());
  const balance = await ethProvider().getBalance(key.address);
  const sent = sendableOf(balance);
  if (sent <= 0n)
    throw new Error(
      `${formatEther(balance)} PAS is not enough to cover sending it`
    );
  const tx = await key.sendTransaction({ to, value: sent });
  await tx.wait().catch(() => undefined);
  await markCashOutSent(record.burner, to);
  return { hash: tx.hash, sent };
}
