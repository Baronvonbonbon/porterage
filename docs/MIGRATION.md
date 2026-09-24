# Replacing a contract without losing what it held

Planned 2026-09-24, after a session in which three contracts were redeployed and
every in-flight order was destroyed each time.

The model is not in question: `PorterUpgradable.migrate` already states it.

> Default no-op — the **freeze-and-drain** model makes copying optional.
> Override for cheap-to-copy state (reputation records, venue pins); escrowed
> value is intentionally never copied (it drains).

Freeze the old contract to *new* business, let *in-flight* business finish on it,
point new business at the successor. No proxies, no delegatecall, no upgrade key
that can rewrite the logic sitting on top of everybody's money. This document is
about the parts of that model nobody built.

---

## Why not the alternatives

**Not proxies.** A `delegatecall` proxy keeps storage and swaps logic, which is
the cleanest possible state preservation and the worst possible security
posture for this system: whoever holds the upgrade key can replace the shield
logic under the vault and take everything. The contracts are deliberately
immutable and the router is a *registry pointing at new deployments*, not a
proxy. That choice is correct and this plan does not revisit it.

**Not copying escrowed value.** A privileged function that can write balances is
a function that can mint them. The vault's posture is already
`upgradeContract(..., freezeOld: false)` — a vault upgrade re-points consumers
and leaves v1 **fully live**, so money drains out of it at its owners' pace
through paths that were never freeze-gated. Value is never copied. It leaves.

## What is already built

| Contract | Copy mechanism | State |
|---|---|---|
| `PorterDrivers` | `importRecords(old, address[])` | **built** — paginated, idempotent, skips live local state; stake deliberately not copied |
| `PorterVenues` | `importVenues(old, uint64[])` | **built** — same shape, keyed by venue id |
| `PorterRatings` | `importAggregates(old, address[], uint64[])` | **built** 2026-09-24 — same shape; `rated` deliberately left behind |
| `PorterVault` | none, by design | value drains; never frozen |
| `PorterOrders` | none, by design | orders drain |

The two that exist are good: paginated so an unbounded list cannot brick the
migration, and they `continue` rather than clobber when the successor already
knows a record.

## The three gaps (all closed 2026-09-24)

### 1. Ratings has no import — **closed**

A driver's *stars* live in `PorterRatings.driverAgg`, not in `PorterDrivers`.
Upgrading Ratings today resets everyone's reputation to nothing while leaving
their delivery counts intact — a half-erased record, which is worse than either
extreme because it looks plausible.

**Fixed:** `importAggregates(old, address[] drivers, uint64[] venues)`, in the
same shape as the other two. `rated` is *not* copied: it is per-order replay
protection and order ids are per-contract, so carrying it would block ratings
for unrelated future orders that reuse the number.

### 2. Nothing calls the imports — **closed**

`migrate` is a no-op in every contract, and the router calls only `migrate`. The
import functions are `onlyOwner` and paginated, so somebody has to enumerate the
records and push them in batches — and there is no tool that does.

The enumeration exists off-chain: `DriverRegistered` and `VenueRegistered`
events are the list. A migration script can read them and page through.

**Fixed:** `scripts/migrate.ts` — reads the events, batches, calls, and then
**reads every record back**. The read-back is the point: an import that
silently skipped half a batch looks exactly like one that worked, and the
failure would surface weeks later as a driver whose rating vanished.

```
OLD_DRIVERS=0x… OLD_VENUES=0x… OLD_RATINGS=0x… \
  npx hardhat run scripts/migrate.ts --network polkadotTestnet
```

Anything left unset is skipped, so one contract can move at a time.

### 3. The client cannot survive a drain window — **closed**

This is the one that turns a migration into corruption rather than a clean
failure, and it has two halves.

**The app never reads the router.** `contracts.ts` resolves every address from
`deployed.json`, baked in at build time. An on-chain upgrade reaches nobody until
the app is rebuilt and republished, which makes the registry decorative.

**Order ids are per-contract and sequential, and nothing records which contract
an order belongs to.** `OrderRecord` holds `id`, `burner`, `lat`, `lon`, `salt` —
no address. Today a redeploy wipes everything so everyone starts fresh and the
collision is invisible. Under freeze-and-drain it is not: order #7 exists on the
old contract *and* on the new one as two different orders, and a stored record
would resolve to whichever the app currently points at. A customer would open
their order and see somebody else's.

**Fixed, both halves.**

`OrderRecord.at` is stamped from `addressOf("orders")` at creation and carried
through every customer-side read and write — `orderOf`, `pickupDeadline`,
`watchBids`, `acceptBid`, `cancelOrder`, `reopenTimedOut` — via `readAt` /
`writeAt` in `contracts.ts`. Records written before the field existed leave it
undefined, which can only mean the deployment of the day, so the fallback to
the current address is the correct answer for them rather than a convenient
one. `web/src/order/at.test.ts` reads the source and fails if a call site drops
it, because this is the failure that corrupts rather than throws: the customer
is shown a stranger's delivery, with a live Cancel button on it.

`resolveFromRouter()` runs once in `main.tsx` before the first render, so the
whole session agrees on one address map. It is best-effort by design — a zero
address, an unreachable RPC or a slow one all leave the baked addresses in
place, and it never fails the app. It widens nobody's trust: the router's owner
is already the upgrade authority.

## The sequence

For a contract with copyable state — Drivers, Venues, Ratings:

1. Deploy the successor. Wire it (`configure`, `setAuthorized`) the way
   `scripts/deploy.ts` already does.
2. `router.upgradeContract(name, new, freezeOld: true)`. The old contract now
   refuses new entries; its exits still work, because `whenNotFrozen` is on
   entry mutators only and never on a drain path.
3. Run `scripts/migrate.ts`. It enumerates from events, pushes batches, and
   re-reads to verify each record landed.
4. Republish the app. Phones that have not updated keep working against the old
   address for anything already in flight.

For a contract whose state drains — Orders, Vault:

1. Deploy and wire the successor.
2. `router.upgradeContract(name, new, freezeOld: false)` for the vault — it must
   stay live, because other contracts' drains credit into it. `true` for orders
   once no order is open.
3. Do **not** migrate. Announce the window. Let in-flight orders settle where
   they were created; clients hold the old address per order and keep using it.
4. Republish once the old contract is quiet.

## What this never fixes

An order that is *open* when its contract freezes cannot be created against the
new one — the customer re-places it. Escrow already committed settles on the old
contract and pays out normally; nothing is lost, but the order number changes.

Shielded notes are not affected by any of this: they live in Kusama Shield and
the vault's note tree, and the vault is never frozen.

## Rehearsal — **done**

A migration that has never been rehearsed is a plan, not a path.
`test/migration-rehearsal.test.ts` is that rehearsal, and it is the acceptance
test for this work. It deploys everything, registers two drivers and a venue,
drives three orders to Delivered so there is real reputation to carry, rates
them, upgrades all three registries, migrates, and then checks:

- every registration, delivery count, metadata URI, venue pin and star
  aggregate arrived unchanged;
- the event log alone finds everyone — there is no on-chain enumeration, so if
  it did not, records would be left behind with nothing reporting it;
- stake stayed behind and drains from the frozen predecessor;
- running it twice moves nothing, including not double-pushing the venue's
  operator index — an operator whose script died mid-run will re-run it;
- a driver who registered on the successor during the window is not rolled
  back to their older self;
- `rated` did not come across;
- the frozen predecessors refuse new entries.

It is deliberately end-to-end rather than three unit tests. The failure it
exists to catch — the half-erased driver whose deliveries survived but whose
stars did not — is invisible when each import is checked on its own, because
each one is individually correct.

## Still true

The rehearsal runs against Hardhat. It has **not** been run against Passet Hub,
and no contract has yet been migrated on a live network.
