# Porterage — technical overview

A peer-to-peer delivery Product that runs inside the Polkadot app. This document
explains how the whole thing works, in one pass, for a person or a model coming
to it cold.

It is written to be read top to bottom. Each section assumes the one before it.
Where a number appears it was measured on chain, not estimated, and says where
it came from. Where something is **not** built, it says so.

**Status:** testnet only (Paseo Asset Hub). Licensed
[AGPL-3.0-or-later](../LICENSE): run a modified Porterage as a service and its
users are entitled to your source.

Other documents, and what each is for:

| file | what it holds |
|---|---|
| [PLAN.md](PLAN.md) | the plan of record — every decision, numbered, with its reasoning |
| [DEPLOY.md](DEPLOY.md) | every deploy and publish, with what it fixed and what it cost |
| [VALUE-FLOW.md](VALUE-FLOW.md) | the value-rail audit: where money can be, and who can move it |
| [FEE-MARKET.md](FEE-MARKET.md) | the submitter auction, in detail |
| [MIGRATION.md](MIGRATION.md) | the freeze-and-drain contract upgrade model |
| [IMPROVEMENTS.md](IMPROVEMENTS.md) | the UX backlog |

---

## 1. What it is, in a page

A customer orders goods from a venue. A driver bids to carry them. The venue
hands the goods over, the driver carries them to the door, and everyone gets
paid. The contracts hold the money in between and release it when both sides
have proved the hand-off happened.

Three things make it different from the obvious version of that:

**There is no server.** The app is a static bundle published to IPFS and
addressed by a `.dot` name. Nothing of Porterage's runs anywhere. A published
version cannot be changed, only replaced, and the contracts do not know or care
which version is talking to them.

**The money moves privately by default.** A customer funds each order from a
fresh account that has never been used before, and funds it out of a shielded
pool, so nothing on chain links the order to the person who paid for it. A
driver's and a venue's earnings go the same way in the other direction. The
privacy is not a mode you switch on; it is the only path the app builds.

**The drop address never leaves the phone.** The order carries a Poseidon hash
of the coordinates. At the door the customer proves in zero knowledge that the
driver is standing within a radius of the committed point. The chain learns
that the proof verified and nothing else.

What Porterage takes: **250 basis points of the fare, and nothing else.** Not
the goods, not the tip, not the vendor's tax. On a 10 PAS order with a 1 PAS
fare that is 0.025 PAS — an effective **0.22%** of what changes hands. Every
other cost in this document is gas paid to the chain or a payment from one
participant to another.

---

## 2. One delivery, end to end

Follow the money and the keys; everything else is detail.

```
CUSTOMER                      CHAIN                        DRIVER / VENUE
────────────────────────────────────────────────────────────────────────
1  withdraw from the shield ──► fresh burner account
     (ZK proof, on the phone)     no history, no link

2  createOrder ──────────────► escrow: goods + tip held
     drop = Poseidon(lat,lon,salt)   window opens

3                               order is visible ◄──────── driver sees it
                                                           commitBid (sealed)
4  acceptSealedBid ──────────► escrow: + fare
                                order Assigned

5                                                          venue signs pickup
                                confirmPickup ◄─────────── driver submits both
                                → venue PAID (goods+tax)

6  ZK proximity proof ───────► confirmDropoffZK
     "the driver is within R     → driver PAID (fare+tip−fee)
      of my committed point"     → order Delivered

7  rate ─────────────────────► stars, one-way
```

Each step, with what actually happens:

**1. Funding a burner.** The customer's money sits in the Kusama Shield pool as
notes. To spend, the phone proves ownership of *some* unspent note without
saying which, binding the proof to a destination address. That proof is posted
to the Statement Store with a tip attached. Anyone can submit it; a stranger
does, because the customer submitting it themselves would link the account to
themselves. The burner arrives funded and unconnected to anything.

**2. Creating the order.** `PorterOrders.createOrder` escrows the goods value
plus the tip and records `dropCommit = Poseidon(lat, lon, salt)`. The salt stays
on the phone. The pickup window must be between **10 minutes and 24 hours**.
The id comes back in the `OrderCreated` log — never from reading `nextOrderId`
beforehand, because two customers ordering in the same moment read the same
number and one of them would carry the other's order for the rest of the flow.

**3. Bidding.** A driver commits `keccak(orderId, driver, amount, salt)` on
chain and sends the opening to the customer sealed. Bids are sealed so drivers
cannot undercut each other by reading the book, and revocable so a driver who
has moved on is not held to a stale price.

**4. Accepting.** The customer pays the agreed fare into escrow. From here the
order has a driver and a deadline.

**5. Pickup.** Two signatures: the driver's attestation and the venue's
countersignature, submitted together by the driver in one transaction. **The
venue is paid the moment this lands** — goods plus whatever tax lines its menu
declared. The venue's risk ends when the goods leave the counter.

**6. Drop-off.** The driver signs a commitment to their position. The customer's
phone produces a Groth16 proof that the driver's committed position lies within
the settlement contract's radius of the customer's committed drop, and that the
nullifier is fresh. `confirmDropoffZK` verifies it and releases the fare and tip
to the driver, less the protocol fee.

**7. Rating.** One-way stars, recorded against driver and venue.

Other endings exist and all of them are tested against the live chain:
`cancelOpen` (nobody took it), `cancelAssigned` (pays the driver
`assignedCancelBps` = **20%** of the fare for being dropped), `abandonOrder`,
`reopenTimedOut` (the driver never came; the goods escrow stays put and only the
fare returns, because a fare is a price agreed with one driver), and disputes
ruled either way.

---

## 3. How each feature uses the Polkadot stack

Porterage is not "a dApp with a Polkadot logo". Each piece of the stack does a
job nothing else in the system could do, and several of the design's stranger
decisions exist because of what a given piece can and cannot do. This section
maps feature to component.

### Paseo Asset Hub — the contracts

All eleven contracts are Solidity, deployed to **Paseo Asset Hub**
(`chainId 420420417`), which runs **PolkaVM through `pallet-revive`** rather
than an EVM. That distinction is not cosmetic:

- **Gas is charged differently, by an order of magnitude.** `createOrder` costs
  196,701 gas on Hardhat's EVM and **21,008** on chain. `insertShieldNote`:
  715,796 against **27,058**. Any cost model built from Hardhat numbers is wrong
  by ~10×, in the expensive direction. `tools/gas-live.mjs` derives the real
  table from a live run; `tools/costs.mjs` prefers it.
- **Proof size is metered as well as gas, per block.** A transaction that would
  succeed alone can be included, revert, burn ~1,905 gas and carry **no revert
  reason** when the block is busy. Two of a hundred live orders died this way,
  in the same block. `web/src/send.ts` retries it, distinguishing it from a real
  revert by requiring *both* no revert data and gas too low to have run
  anything.
- **PAS has 10 decimals on the Substrate side and 18 on the EVM side.**
  Conversions live in one place (`PLANCK_PER_WEI = 10n ** 8n`).

### Two ways to call a contract

This is the crux of the identity design, and it is worth being precise.

| caller | signs | how it calls | cost to the user |
|---|---|---|---|
| host account (the person's Polkadot app account) | sr25519 | Substrate `Revive.call` | **one tap per call** |
| session key / burner (an Ethereum key the app holds) | secp256k1 | ordinary EVM transaction | no tap |

An sr25519 account cannot sign an Ethereum transaction, so anything done *as the
person* goes through `Revive.call`, signed by the host — and on mobile that
means a prompt every single time (`AutoSigning` is `NotAvailable`). Every call
is dry-run through `ReviveApi.call` first, which yields the weight and storage
deposit to allow and turns a revert into an error *before* the user is asked to
tap.

So the app is arranged around that cost. Registering as a driver or a venue,
depositing to the shield, publishing a menu: those are taps, and they are rare.
Bidding, cosigning, settling, rating, ordering: those run on session keys and
burners over the Ethereum RPC, and cost nothing but gas. `contracts.ts` builds
every signer-bound contract through `writable()`, and `contracts.test.ts` reads
the source and fails if a new one skips it — because a `Wallet` with no provider
still looks like a `Wallet` and fails only at send time, which is how every
driver write was silently broken once.

### Polkadot Bulletin chain — menus, photos, evidence, backups

Anything larger than a statement and longer-lived than an hour goes to Bulletin
as a preimage, addressed by its BLAKE2b-256 hash. Venue menus, storefront and
driver photos, dispute evidence, encrypted day-end books, and the shielded note
book's backup.

Two properties shape everything built on it:

- **Only the host can write.** `hostPut` needs a `BulletinAllowance` resource
  allocation and a `PreimageSubmit` permission, which land on a slot account
  only the host can sign with. `cloudStorage.upload` does *not* work — it signs
  with the product account, which holds no Bulletin authorization, and is
  refused `Invalid: Payment`. **No script can write to Bulletin**, which is why
  the demo venues carry their menus inside the app bundle instead.
- **A write costs a prompt every time, and content lasts about two weeks.**
  Measured at 31.5 s then 5.6 s. This is why thread archives are an explicit
  action rather than something the message path does, why the books back up once
  per day rather than per sale, and why a demo set published to Bulletin would
  silently rot every fortnight.

Because the key is a content hash, a cached document can never be stale: a
changed menu is a different URI.

### Statement Store — the funding market

Short-lived, signed, addressed broadcasts: funding requests, bid openings,
submitter claims, order chat bootstrapping. Statements are signed by the
product's **statement allowance account**, not the user's, so a funding request
does not name the customer. Each goes on one channel per requester — a new
request replaces the last — with **an hour's expiry**, because a statement with
no expiry is kept forever and the account fills and locks.

This is the transport for the fee market: a customer posts a withdrawal request
with a climbing offer, submitters watch, claim a job before spending gas on it,
and re-price as the offer rises to its cap. See [FEE-MARKET.md](FEE-MARKET.md).

### Kusama Shield — the private pool

The customer's balance lives in Kusama Shield's pool on Asset Hub
(`0x7d5a…e0dC`), native PAS and assets in one Merkle tree. Deposits are made
from the host account (one tap for any number of notes); withdrawals are Groth16
proofs that anyone may submit.

One Asset Hub–specific trap shapes the client: **a deposit sent as a Substrate
`Revive.call` leaves no `eth_getLogs` entry at all.** Measured — the tree grew
by two in block 13456840, which showed no transactions and no logs; the events
were in `System.Events` like any other Substrate event. So the client reads
leaves from Ethereum logs, checks each range's count against the pool's
`treeSize` at that block, and reads any block that grew without logs from the
Substrate side.

### People chain — personhood, and the relay

`PorterDrivers` and `PorterVenues` carry a personhood gate
(`IPorterPersonhood`). It **ships off**: `address(0)` gates nobody, and `minStake`
is 0, so registration alone qualifies. The hook exists so that a real deployment
can require proof of personhood without a redeploy.

The optional relay listens on the People chains' Statement Store and submits
valid funding requests for the tip. It is a convenience, never a dependency:
any driver with "Help fund private orders" enabled does the same job, and the
relay holds nobody's money — the proof fixes where each withdrawal goes, and a
bad one is rejected by the gas estimate for free. It runs on its own key,
because the deploy key is *also* the treasury, the arbiter and the upgrade
authority, and is the last thing that should sit on a networked machine
unattended.

### The Polkadot app itself — host, identity, delivery

The app is published as a Product under the `.dot` label `porterage`, addressed
by content hash. Every product-scoped key and account derives from that label.
Outside the Polkadot app — a plain browser, the `dev-dot.li` gateway — `inHost()`
returns false and the app runs **read-only**: no host account, no Bulletin, no
statements.

Host calls can *stall* rather than reject (an upload once hung 180 s with no
error), so nothing crosses to the host without a deadline.

---

## 4. The contracts, and who may call what

Eleven contracts, plus libraries, interfaces and mocks.

| contract | holds | notable |
|---|---|---|
| `PorterOrders` | the order book and all escrow | the state machine; `feeBps`, `assignedCancelBps`, the relay fee curve |
| `PorterSettlement` | nothing | pickup cosigning, `confirmDropoffZK`, the dropoff radius |
| `PorterVault` | earnings and shielded notes | `insertShieldNote`, a 16-level Poseidon tree, `tip()` |
| `PorterDrivers` | driver records, stake, session keys | personhood gate, slashing, unbonding |
| `PorterVenues` | venue records | `setActive`, `setMetadata`, operator-gated |
| `PorterRatings` | star aggregates | `importAggregates` for migration |
| `PorterDisputes` | dispute records and bonds | arbiter-ruled, evidence commitments |
| `PorterLocationVerifier` | nothing | Groth16 verifier for the proximity circuit |
| `PorterShieldVerifier` | nothing | Groth16 verifier for the note-spend circuit |
| `PorterPauseRegistry` | pause state per category | guardian pauses alone and instantly; **only the owner unpauses** |
| `PorterGovernanceRouter` | the current address of each contract | how a client finds the live deployment |

Order status: `Open(1) Assigned(2) PickedUp(3) Delivered(4) Cancelled(5)
Disputed(6)`.

Live parameters, read from chain:

```
feeBps              250     of the FARE only
assignedCancelBps  2000     compensation to a dropped driver
disputeBond           0     bootstrap
relayServiceFee       0     flat, per order
withdrawFeeBps        0
shield buckets        1, 5, 25, 100 PAS
MIN_WINDOW           10 minutes      MAX_WINDOW  24 hours
```

Access control is a matrix, and there is a test that *is* the matrix: adding a
privileged function without adding its row fails the suite.

### Upgrades: freeze and drain

There are **no proxies**. `PorterUpgradable.migrate` freezes a contract against
new entries, copies reputation to its successor, and lets escrowed value drain
out of the old one. Two deployments are live at once during the drain.

The consequence that matters to the client: **order ids are per-contract and
sequential**, so `#7` exists on both contracts as two unrelated orders. Every
stored `OrderRecord` carries `at` — the contract it belongs to — stamped at
creation and threaded through every read and write. `at.test.ts` walks the
source and fails if a call site drops it. Without it, opening a stored order
resolves it against whichever contract the app currently points at and shows a
customer a stranger's delivery with a live Cancel button.

See [MIGRATION.md](MIGRATION.md).

---

## 5. The privacy rail

Three separate mechanisms, often confused.

**The shielded pool (customer money in).** Kusama Shield notes. Spending proves
ownership of an unspent note without revealing which, so the anonymity set is
every unspent note in the tree. A withdrawal spends exactly one note and pays a
fee, so a plan may need several notes — and a multi-note withdrawal lands them
in one account, which links those notes to each other. The app says so plainly
rather than hiding it.

**The vault's note tree (driver and venue money out).** Earnings accumulate in
`PorterVault` against a named address. `insertShieldNote` moves a **fixed
bucket** into the vault's own 16-level Poseidon tree — that step is signed by
the payee and is linked to them, like any deposit. Later, a Groth16 proof spends
some note in that tree, revealing only a nullifier, and *someone else* submits
it. The two steps are deliberately far apart in time, and the app says so.

Buckets mean a balance below 1 PAS cannot be shielded and waits. It also means
the shielding cost is paid **once per bucket, not once per delivery** — a driver
taking 1 PAS fares and shielding at 100 PAS pays 27,058 gas for a hundred jobs.

**Burner accounts (the order itself).** Each order is placed from a fresh
Ethereum key derived from device entropy, funded out of the shield by a
stranger. The order, the bid acceptance, the drop proof and the rating all come
from that key. It has no history.

**The drop commitment.** `Poseidon(lat, lon, salt)` on chain; the salt on the
phone. The proximity circuit takes the customer's coordinates and the driver's
committed position as private inputs and proves the distance is within the
radius. A nullifier derived from the salt and order id stops a proof being
replayed.

One thing to be honest about: **the arbiter is still a single key**, and it is
currently the deploy key, which is also the treasury and the upgrade authority.

### A rule worth stating

A cash-out **stops at an unlinked account and stays there.** Carrying it onward
into a named wallet would be one line, and every other delivery app does exactly
that — it would also throw away what the withdrawal just bought, because paying
a named address from an unlinked one publishes the amount and the time against a
name. That hop is a separate button with its cost written beside it.

---

## 6. The client, and where state lives

A React + TypeScript single-page app, built by Vite, published as a static
bundle. No server, no backend, no database.

```
web/src/
  config.ts        where the chain is, what the product is called
  contracts.ts     ABIs, addresses, read()/readAt()/writable()
  host.ts          the Polkadot app host: Bulletin, permissions, inHost()
  hostchain.ts     Substrate Revive.call from the user's account
  send.ts          transaction send with the proof-size retry
  keys.ts          every derived key: burners, session keys, note secrets
  order/           orders, bids, handoff, evidence, disputes, menus, geo
  shield/          notes, pool, plan, deposit, cashout, payout, recover
  market/          statements, the submitter auction
  books/           ledger, CSV export, encrypted day-end backup
  views/           screens, one directory per role
```

**State lives in exactly three places**, and which one a thing lives in is a
decision, not an accident:

1. **On chain** — money, order state, reputation, registrations.
2. **On the device** — note secrets, the drop salt, order records, receipts,
   the counter photo waiting to be committed. Never leaves, except as an
   encrypted Bulletin backup under the account's own derived key.
   **Customer receipts are never backed up**, and have a delete button.
3. **On Bulletin / the Statement Store** — anything other people must read.

Restoring a note-book backup **merges**; spent is one-way, so an old backup can
never resurrect a spent note and publish its nullifier for nothing.

### Loading

The startup bundle is **183 kB gzipped** (down from 817 kB). The splash screen —
markup, styles and the mark — is inlined in `index.html` so it paints from the
first bytes rather than after 2 MB of JavaScript has crossed IPFS. Role screens,
the QR scanner, snarkjs and the note-backup panel are all lazy.

Two traps, both of which have bitten:

- A lazy `import()` that **rejects** is an error, not a suspension. `Suspense`
  does not catch it; only an error boundary does. Inlining the stylesheet while
  *deleting* the CSS asset made every lazy chunk's preload 404, and with no
  boundary the whole app blanked. `tools/check-dist.mjs` now fails the build if
  the bundle references a file it does not ship.
- `poseidon-lite`'s package barrel re-exports all sixteen arities with their
  constant tables — 609 kB. The app uses 1, 2 and 3. Import the per-arity entry
  points. `shield/poseidon.test.ts` pins fixed hash vectors, because a silently
  changed Poseidon strands every note already committed and nothing else would
  have caught it.

---

## 7. What it costs, measured

Gas measured across 100 live orders on Passet Hub, at Paseo's price of 1e12 wei
per unit (so 1,000,000 gas = 1 PAS). These are the real numbers, not Hardhat's.

| who | call | gas | PAS |
|---|---|---:|---:|
| customer | `createOrder` | 21,008 | 0.0210 |
| driver | `commitBid` | 10,367 | 0.0104 |
| customer | `acceptSealedBid` | 4,042 | 0.0040 |
| driver | `confirmPickup` | 13,062 | 0.0131 |
| customer | `confirmDropoffZK` | 17,005 | 0.0170 |
| customer | `rate` | 6,227 | 0.0062 |
| | **one delivery** | **71,711** | **0.0717** |

Other endings: `cancelOpen` 5,393 · `cancelAssigned` 7,243 · `abandonOrder`
6,488 · `reopenTimedOut` 7,181 · `openDispute` 17,027 · `resolveDispute` 7,179.
Once, ever: `registerDriver` 19,461 · `registerVenue` 25,940. The expensive one:
`insertShieldNote` 27,058, which walks a 16-level Poseidon tree on chain, paid
once per bucket.

Gas for all three sides, steady state: **0.0747 PAS, 0.7% of a delivery's
value.** The protocol's own take on the same delivery: **0.025 PAS, 0.22%.**

`node tools/costs.mjs` prints this from live parameters rather than from prose,
because a cost written into a document is wrong within a month and nobody
notices — which happened to this project's own cost tool, by a factor of ten.

---

## 8. Testing, and what it does not cover

- **218 contract tests** (Hardhat) — including an access-control matrix and a
  full migration rehearsal.
- **251 web tests** (Vitest) — mostly logic in a node environment; render tests
  opt into happy-dom per file with `// @vitest-environment happy-dom`.
- **`web/tools/fleet.ts`** — a hundred orders against the live contracts across
  five lanes, every ending, every global lever, with a three-way cost ledger
  separating gas from protocol charges from payments between participants. Last
  run: 98/100 as planned in 15.9 minutes, the two failures being the proof-size
  refusal described above.

The suite had 232 tests and **not one of them mounted a component** until a
screen that blanked the entire app shipped twice. If you are adding UI, add a
render test; the typecheck cannot see a throw during render and neither can a
logic test.

The fleet harness deliberately does **not** cover the Statement Store, Bulletin,
WebRTC or the host account: every one of those needs a phone with a person
tapping it. That boundary is the honest one — the harness proves the contracts
and the money, not the transport.

---

## 9. Traps worth knowing before you touch anything

Each of these cost real debugging time and none is obvious from the code.

1. **The event log is not an enumeration.** Venue #6 is live on chain with a
   `PickupRecorded` event of its own and its `VenueRegistered` **absent from the
   RPC's log index**. Enumerate from storage where the contract allows it.
2. **Proof size, not gas, is the binding limit.** It splits batches, it kills
   concurrent orders, and it reports as a reasonless revert with ~1,905 gas.
3. **Order ids are per-contract.** Always carry `record.at`.
4. **Hardhat gas is not chain gas.** Off by ~10×, sometimes 26×.
5. **A `Wallet` with no provider signs but cannot send.** Build through
   `writable()`.
6. **`JsonRpcProvider` keeps a polling timer alive** — a node script never exits
   without `eth.destroy()`.
7. **A lazy `import()` that rejects needs an error boundary, not `Suspense`.**
8. **A newest-first list with a cap is a rule about who is visible.**
   `allVenues` once capped *ids visited*, and twenty test venues made the only
   real shop unreachable. Nothing failed; the list was simply full.
9. **Anything a harness writes to a shared registry, it must take back.** Test
   venues registered by `Wallet.createRandom()` operators can never be closed by
   anyone, because `setActive` is operator-gated and the key is gone.

---

## 10. What is not built

Stated plainly, because a document that only describes what works is a sales
brochure.

- **Mainnet.** Testnet only. See PLAN.md §9 for the gate.
- **A decentralised arbiter.** Disputes are ruled by a single key, which is
  currently also the treasury and the upgrade authority.
- **Personhood.** The gate exists and ships off.
- **Stake.** `minStake` is 0; registration alone qualifies a driver.
- **A real venue onboarding flow.** Venues register and publish a menu, but
  there is no verification that a venue is a shop.
- **Measured camera/QR performance on a real device.** Still unmeasured.
- **Any index.** `allVenues` walks ids. Honest at a few hundred venues, wrong at
  a few thousand; the answer there is an index by area, not a bigger limit.
- **Demo venues are shipped with the app** (`src/order/demo.json`, ids #37–41)
  and marked as such in the UI, because nothing outside the Polkadot app can
  write to Bulletin. `web/tools/demo-venues.mjs --retire` removes them.

---

## 11. Orientation for an agent

If you are a model opening this repo, read in this order: this file, then
`docs/PLAN.md` for the reasoning behind any decision you are about to change,
then `docs/DEPLOY.md` for what has already been tried and what it cost.

- `docs/PLAN.md` is the **plan of record**. If code and PLAN.md disagree, that
  is a finding, not a licence to pick one.
- `docs/DEPLOY.md` is append-only history. Add a row when you publish.
- Comments in this codebase explain **why**, and frequently record a specific
  failure and its date. They are load-bearing. Do not compress them away.
- Numbers must come from a measurement with a stated source, or not appear.
- Before adding a dependency, check whether the bundle can afford it: the
  startup path is 183 kB gzipped and that was hard-won.
- `npm test` at the repo root runs Hardhat; `npm test` in `web/` runs Vitest;
  `npm run build` in `web/` also runs `tools/check-dist.mjs`.
