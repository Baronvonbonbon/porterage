# The fee market: paying strangers to front gas

Scoped 2026-09-21. Plan of record for turning the hardcoded and governance-set
submission fees into an open market that anyone can compete in, with a guarantee
that a submitter is never underwater and a customer is never gouged.

The rule this is built against, in the user's words: *a profitability guard that
will ensure gas fees will be covered, and a fee charge that anyone can set.
Orders are published, anyone online can pay the fee, the lowest price wins after
a short delay window but should still be profitable. The order gas fee should
not be unbounded.*

---

## What already exists

Worth saying first, because half of this is built. `web/src/market/submit.ts`
already refuses any request whose fee does not cover gas by 1.5×
(`DEFAULT_POLICY.minFeeOverGas`), and it uses `estimateGas` as the validity
check — so a bad proof, a spent note or an evicted root fails there and costs the
submitter nothing. **The profitability guard is real and it works.** What is
missing is price *competition*, a *ceiling*, and the same treatment on the other
three rails.

## The four paths where someone else fronts gas

| Path | Fronted by | Fee today | Can it carry a market fee? |
|---|---|---|---|
| `shieldPool.withdraw` (`submitRequest`) | any stranger | 0.3 PAS flat, post-hoc from the burner | **yes** — burner pays after the fact |
| `vault.insertShieldNoteFor` / `…TokenFor` | a relay | free | **yes** — from the payee's remaining balance |
| `orders` relay settle (`relayServiceFee`) | a venue relay | 0, dormant | **yes** — escrowed at creation |
| `vault.depositShieldNoteZK` (`submitPayout`) | any stranger | free | **no, and it must stay that way** |

### Why the payout spend stays free

`depositShieldNoteZK` burns a vault note of exactly `bucket` and deposits exactly
`bucket` into the shielded pool under `ksCommitment`. The amount is fixed by the
proof and by the commitment; there is no slack in it.

A fee could only come out of the bucket, and that would deposit a non-standard
amount. **The fixed denominations — 1, 5, 25 and 100 PAS — are the anonymity
set.** A deposit of 4.97 PAS is a fingerprint: it identifies its owner across the
pool for as long as the pool exists. Charging a fee here would trade a few
thousandths of a PAS for the privacy the entire design is built to provide.

So this path keeps its existing bargain — the gas is small and it is done as a
public good — and gains only the bounded-gas guard below, so a submitter can see
what it will cost before choosing to do it. This is the one place "every rail
carries a fee" does not hold, and it is deliberate.

## The mechanism: a rising price, first taker wins

The auction cannot live on-chain. The whole premise is that the requester either
cannot or will not send a transaction — running an on-chain auction for the right
to submit your transaction is circular. So it runs on the Statement Store, which
is free, costs no tap and holds 512 B: the same place order bids already live.

A request publishes its schedule alongside its payload:

```
price(t) = floor + (ceiling − floor) × clamp((t − startedAt) / climbSecs, 0, 1)

floor      = estimated gas cost × 1.5     (MIN_MARGIN, the existing guard)
ceiling    = estimated gas cost × 4       (MAX_MARGIN)
climbSecs  = 30
```

Each submitter computes its *own* cost — its own gas estimate at its own gas
price, times its own margin — and takes the job the moment `price(t)` clears it.
The operator with the lowest real cost clears first, so **the lowest price wins
by construction**, with no second round trip and no selection step. This matters
more than it looks: the requester is a phone, and a design that needs it awake to
pick a winner 30 seconds later is a design that fails when the screen locks.

Payment is post-hoc and capped: the requester sees which transaction landed,
reads its block timestamp, and pays `price(t_submit)`, never more than `ceiling`.

### Why a rising price rather than sealed quotes

Sealed quotes give a true lowest price, but they need the requester awake for a
second statement round trip and add that delay to every withdrawal. The rising
price gets the same outcome from the submitters' own cost curves while the phone
sleeps. The cost is that the winner is paid slightly above its true cost — it is
paid whatever the clock reached, not what it would have accepted. That is the
premium for not needing the requester present, and it is bounded by `ceiling`.

## Bounding the cost

"Not unbounded, within a minimal limit" lands in four places:

- **`floor` never below 1.5× gas.** A submitter is structurally never underwater.
- **`ceiling` at 4× gas.** A hard cap: no request can ever offer more, whatever
  the clock says. Expressed as a multiple of *measured* gas rather than a flat
  PAS figure, so it stays sane when gas prices move and on a chain that is not
  Paseo, with no governance tap needed to keep it current.
- **`gasLimit` pinned** at `estimateGas × 6/5`, as today.
- **A failed estimate means skip.** Already true, and it is what makes a bad
  request free to decline.

The requester estimates gas when publishing. A submitter's own estimate will
differ slightly; that is fine and self-correcting, because a submitter whose real
cost never clears the ceiling simply declines and the request goes to someone
cheaper. If nobody takes it by the ceiling, the request expires and is
republished with a fresh estimate.

## Not burning the loser's gas

Today's first-come-first-served race means two submitters can both send, and the
one that lands second pays full gas for a reverted transaction. The nullifier
keeps this *correct*, but it is pure waste and it drives honest submitters away.

Before sending, a submitter publishes a short-TTL `claim` statement and backs off
if someone else's is already live. Statements cost nothing and no tap, so this is
free. It is not airtight — two claims can cross in flight — but it turns the
common case from a race into a queue, and correctness never depended on it.

## Shielding the fees

Submitter income is the last clear-value leak `VALUE-FLOW.md` lists. Today
`payTip` does `burner.sendTransaction({to: submitter, value: tip})` — a plain
transfer that accumulates at an address, and for a driver running the funding
helper that address is their session key, which `PorterDrivers.actsFor` already
ties publicly to them. A competitive market with per-request prices would make
that *worse*, not better: more transfers, more amounts, more to correlate.

So fees are paid **into the vault**, not to an address. A fee credited to a
submitter's vault balance shields through `insertShieldNote` exactly like a
driver's fare or a venue's takings, and the market stops leaking who earned what.

This is the reason two of the vault changes below exist, and it is why they are
not optional extras.

## Contract changes

### PorterVault (do this first — see the timing note)

1. **`tip(address payee) payable`** — permissionless; credits `payee`'s vault
   balance by `msg.value`. This is what lets the burner pay a withdrawal
   submitter into the shielded rail instead of in the clear. It cannot break the
   accounting invariant: it credits exactly what it receives. `credit()` stays
   `onlyAuthorized` and is untouched.
2. **A fee on `insertShieldNoteFor` / `insertShieldNoteTokenFor`** — add `maxFee`
   to the signed typehash, so the payee authorises the cap themselves, and let
   the submitter claim any `fee ≤ maxFee`. The vault requires
   `balanceOf[account] ≥ bucket + fee`, moves `fee` to `balanceOf[msg.sender]`
   (not to an address — the fee stays shielded), then inserts the note. **The
   note is still exactly one bucket**, so the anonymity set is untouched: the fee
   comes out of the payee's remaining balance, never out of the denomination.
   The typehash must be a new one, not an edited one, so a signature authorising
   a free insertion can never be replayed as a fee-bearing one.
3. **`depositShieldNoteZK` unchanged**, for the reason given above.

### PorterOrders (schedule separately)

`relayServiceFee` becomes a ceiling rather than a price: the customer escrows
`ceiling` at creation, the relay is paid `price(t)` at settle, and the difference
is refunded to the customer. This is the same mechanism, but it needs an orders
redeploy — **which resets live order state**, so it waits for a moment when
nothing is in flight. It is dormant today (0), so nothing is broken meanwhile.

## The timing note, which is the expensive part of this plan

The newly deployed vault at `0x21A7F0C49b4cd0B03ae4DD63df462722f12D0fDE` holds
**0 PAS**. It is empty.

A vault change made while it is empty costs a redeploy and nothing else. The same
change made after drivers and venues hold balances in it strands those balances,
exactly as this project just stranded 23.275 PAS in the previous vault, because
`PorterVault` has no `migrate` and the router cannot copy balances.

The vault changes above should therefore land **before the vault holds anyone's
money**, not after the market is proven. That inverts the usual order — normally
you would prove the mechanism before changing a contract — and it is worth the
inversion, because the alternative is a second stranding with a known price.

## Phases

1. **The auction, off-chain.** `price(t)`, the schedule in the request statement,
   the ceiling, the claim-before-submit back-off, and the submitter guard
   generalised across all four paths. No contract change; covers the withdrawal
   tip end to end immediately, because that fee is already paid post-hoc.
2. **Vault v2.** `tip()` and the fee-bearing `insertShieldNoteFor`. Deploy while
   empty. Fees become shielded, and the relay-insertion path starts paying.
3. **Orders.** The market-priced relay fee, when no orders are in flight.

## Open risks

- **The requester pays voluntarily.** Enforcement is post-hoc and capped, by
  decision: atomic enforcement needs either a contract deployed per withdrawal or
  a new trusted setup and a 32.8 MB proving-key republish. A requester that never
  pays gets no submitters next time, and a front-runner that ignores the claim
  burns its own gas. Both are reputational, not cryptographic, and this is the
  weakest joint in the design. Worth revisiting if submitters ever report being
  stiffed.
- **A single submitter is a price-setter.** With one operator online, the price
  always climbs to the ceiling, which is why the ceiling is a hard multiple and
  not advisory. The market is only a market with more than one participant.
- **Gas estimates drift** between the requester's estimate and the submitter's.
  Bounded by both sides applying their own guard, but it means the published
  floor is an approximation, not a promise.
