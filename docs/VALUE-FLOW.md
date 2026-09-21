# Where value moves, and what it says about who moved it

Written 2026-09-21, from an audit of every path value can take through Porterage.

The design spends a great deal of effort making an *order* unlinkable: a burner account per
order, a commitment instead of an address, a sealed basket, a proof instead of a position. All of
that is undone the moment someone's **earnings** land in the account everybody already knows is
theirs, in an amount that says how much work they did. So this is the ledger of every rail, what
it leaks, and what was done about it.

The rule the audit was run against, in the user's words: *no option to leak value flow to
identity by sending payments directly between accounts.*

---

## The rails

| Rail | Who | Was it in the clear? | Now |
|---|---|---|---|
| Host account → Kusama Shield | customer | shielded | unchanged |
| Shield → burner (withdrawal) | customer | ZK proof, submitted by a stranger | unchanged |
| Burner → order escrow | customer | burner is unlinked | unchanged |
| Escrow → venue (at pickup) | venue | credited in the vault | vault is now shielded-only |
| Escrow → driver (at dropoff) | driver | credited in the vault | vault is now shielded-only |
| Escrow → treasury (protocol fee) | protocol | credited in the vault | vault is now shielded-only |
| **Vault → a named address** | anyone earning | **six functions, wide open** | **shut by default** |
| Vault → shielded note → pool | anyone earning | ZK, unlinkable | unchanged, and never gated |
| Burner → submitter (the funding fee) | a stranger | **in the clear** | **shielded: `vault.tip()` credits, never transfers** |
| Payee → inserter (note-insertion fee) | a stranger | did not exist | credited inside the vault, at a signed cap |
| Driver host account → session key (gas) | driver | in the clear | unchanged, and it leaks nothing new |

## What was closed

`PorterVault` had six ways to move a balance to a named address: `withdraw`, `withdrawTo`,
`withdrawToken`, `withdrawTokenTo`, `withdrawFor` and `withdrawForToken`. The app never called any
of them — earnings go through `insertShieldNote` — but "the app doesn't use it" is not a property,
it is a habit. Any other client, or a later screen written in a hurry, could reach for the
convenient one.

They are now behind `clearExitsOpen`, which **ships false**. While it is false those six revert
with `shielded-only`, and the only way out of the vault is a bucket of balance turned into a
Kusama Shield note and spent with a proof that binds nothing to the earner.

**Deployed 2026-09-21**, and redeployed the same day at
`0x013fd0C18f8EaC04Cb700330fDDC1A14ca833Bf3` to add the fee rail below, with `clearExitsOpen` read
back as `false` from the live chain each time rather than assumed from the source. The first
vault's remaining 23.275 PAS is stranded:
the keys that could have withdrawn it were `Wallet.createRandom()` in a test harness and no longer
exist. That is the honest cost of this change and it is written here rather than left out.

**Why a flag and not a deletion.** This contract's own rule is that nothing is ever trapped. If the
shield pool were broken, unreachable, or its verifying key wrong, deleting the clear path would
strand every balance in the vault for good. Governance can open the door; nobody else can.

**The shielded path is never gated** — not by this flag, not by the freeze, not by a pause. Money
can always leave. It just has to leave privately. `test/vault-shielded-only.test.ts` asserts
exactly that, and it exists because every *other* suite opens the gate in its fixture: that is how
a default quietly stops being one.

**What it costs, plainly.** A balance below the smallest bucket (1 PAS) cannot be shielded, so it
waits in the vault until more earnings push it over. Someone who stops using Porterage for ever
leaves less than one bucket behind. That is the price of not offering a leak.

## The fee rail, which was the last one open

**The funding tip — CLOSED 2026-09-21.** When a stranger submitted a customer's shield withdrawal,
the burner paid them a plain transfer. That never leaked the *customer* — the burner is unlinked to
them, which is the entire point of it — but it leaked the *submitter's* income: fees accumulated at
an address, and if that submitter was a driver running the funding helper, the address was their
session key, which `PorterDrivers.actsFor` already ties publicly to their identity.

`PorterVault.tip(address)` now takes that payment. It is permissionless, because a burner is nobody
and still has to be able to pay, and it credits rather than transfers — so a submitter's fee income
shields through `insertShieldNote` exactly like a fare or a venue's takings. The same is true of the
fee a payee pays to have their note inserted (`insertShieldNoteFor`), which is credited inside the
vault and never leaves it in the clear.

It did not need the change to the proof that this file once predicted. The fee was never a public
signal of the circuit; it was always paid separately, which is why routing it somewhere else cost a
vault function rather than a new trusted setup.

## What is still in the clear

**The driver's session key gas.** `hostFund` moves PAS from a driver's host account to their
session key in the clear. This leaks nothing new: `registerWithSessionKey` publishes that mapping
on-chain by design. Which is worth saying out loud — **drivers are not anonymous in this system
and were never meant to be.** They are registered, rated, named and chosen on their record. The
anonymity here belongs to the customer, and to the driver's *earnings*, not to the driver.

## The other half of the question: what it costs

`node tools/costs.mjs` reads the gas snapshot the test suite maintains and the fee parameters the
chain actually holds, and prints what they come to per role. It is a tool rather than a table in
this file because every number in it moves, and a cost written into prose is wrong within a month
with nobody noticing.

At the parameters deployed on 2026-09-21, for a delivery of 10 PAS of goods with a 1 PAS fare:

- **Effective service fee: 0.22%** — 0.025 PAS, which is `feeBps` (250) of the **fare only**.
  Porterage takes nothing from the goods, nothing from the tip, nothing from the tax.
- **Gas, all three sides, steady state: about 0.99 PAS**, or 9% of the delivery's value at Paseo's
  testnet gas price. That is the cost of using a chain, not a fee.
- **Plus whatever the submission auction clears at**, between 1.5x and 4x the withdrawal's gas
  (`web/src/market/auction.ts`). A market price, not a fee, and paid to another participant.

The expensive single operation is `insertShieldNote` at 715,796 gas — twelve times a plain
withdrawal — because it walks a 16-level Poseidon tree on-chain. It is paid **once per bucket**,
not once per delivery: a driver shielding at 100 PAS pays it once for a hundred fares, which is why
the per-delivery share above is 0.007 PAS rather than 0.72. Shielding in small buckets is the
expensive way to be private; shielding in large ones is nearly free per job.
