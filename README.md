# Porterage

Peer-to-peer delivery that lives entirely inside the Polkadot app. Customers, drivers and venues
deal directly: drivers bid for the fare in a sealed auction, and money moves only when the parties
whose interests conflict both sign.

There is no server. The app is a static bundle published to IPFS and reached by a `.dot` name;
nothing of Porterage's runs anywhere. The contracts hold the money in between and release it when
both sides have proved the hand-off happened.

## Try it

| | |
|---|---|
| In the Polkadot app | **`porterage.dot`** — mobile or desktop |
| In a browser | [porterage.dev-dot.li](https://porterage.dev-dot.li) — **read-only** |

Outside the Polkadot app there is no host account, no Bulletin and no Statement Store, so the app
runs read-only: you can browse, but not order. Testnet only — it spends Paseo PAS, which is not
money.

Five demo venues ship with the app, marked as such. Ordering from one works and settles for real;
nobody is cooking.

## What makes it different

- **No required servers.** Polkadot primitives first: the Statement Store for signalling, WebRTC for
  chat, Bulletin for evidence and menus, host notifications. The relay is an optional convenience
  node that holds nobody's money.
- **Private by default, not as a mode.** Every order is placed from a fresh account funded out of
  Kusama Shield by a stranger, so nothing on chain links it to the person who paid. Drivers and
  venues take earnings out the same way.
- **The drop address never leaves the phone.** The order carries only `Poseidon(lat, lon, salt)`.
  At the door the customer proves in zero knowledge that the driver stands within a radius of the
  committed point; the chain learns that the proof verified and nothing else.
- **Few taps.** A Polkadot app account signs sr25519 and cannot send an Ethereum transaction, so
  acting *as the person* costs a prompt every time. Rare actions — registering, depositing,
  publishing a menu — are taps. Bidding, settling, ordering and rating run on session keys and
  burners, and cost nothing but gas.
- **No GPS needed.** Hand-offs settle by QR and two signatures; GPS is added as evidence when the
  app allows it.

## What it costs

Porterage takes **250 basis points of the fare, and nothing else** — not the goods, not the tip, not
the vendor's tax. On a 10 PAS order with a 1 PAS fare that is **0.22%** of what changes hands.

One delivery costs **71,711 gas** across both sides, measured over a hundred live orders on Paseo
Asset Hub — about 0.7% of the delivery's value at testnet prices. `node tools/costs.mjs` prints the
current numbers from the chain rather than from this file, because a cost written into prose is
wrong within a month and nobody notices.

## How it works

**[docs/OVERVIEW.md](docs/OVERVIEW.md)** — the whole system in one pass, written for a person or a
model coming to it cold: one delivery end to end, how each feature uses the Polkadot stack, the
contracts and who may call what, the privacy rail, what it costs, and what is *not* built.

| | |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | the plan of record: every decision, numbered, with its reasoning |
| [docs/DEPLOY.md](docs/DEPLOY.md) | every deploy and publish, what it fixed and what it cost |
| [docs/VALUE-FLOW.md](docs/VALUE-FLOW.md) | where money can be, and who can move it |
| [docs/FEE-MARKET.md](docs/FEE-MARKET.md) | the submitter auction |
| [docs/MIGRATION.md](docs/MIGRATION.md) | the freeze-and-drain upgrade model |
| [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md) | the UX backlog |

## Layout

```
contracts/     eleven Solidity contracts, plus libs, interfaces and mocks
circuits/      the two Circom circuits: drop proximity, shielded note spend
scripts/       deploy, migrate, ZK trusted setup
test/          Hardhat tests, including the access-control matrix
tools/         cost model, gas table, key management, app publishing
web/           the app
  src/         config, contracts, host, order, shield, market, books, views
  tools/       the live harnesses — one order, a hundred orders, the relay
docs/          see above
```

## Build and test

Node 20+. The contracts and the app are separate npm projects.

```sh
npm install && npm test            # 218 contract tests (Hardhat)
cd web && npm install && npm test  # 251 app tests (Vitest)
cd web && npm run dev              # the app, read-only outside the Polkadot app
```

The ZK artifacts are committed, so a clone needs no trusted setup. To redo it you need
`circom ≥ 2.1`, then `node scripts/setup-zk.mjs`.

Two things about the app build worth knowing: `npm run build` also runs `tools/check-dist.mjs`,
which fails if the bundle references a file it does not ship — a missing chunk makes a dynamic
import reject and the screen never opens. And render tests opt into a DOM per file with
`// @vitest-environment happy-dom`; the rest of the suite runs in node.

## Against a live chain

`web/tools/` holds harnesses that run against the deployed contracts rather than a local node.
`fleet.ts` is the big one: a hundred orders across five lanes, every way an order can end, every
global lever pulled, with a three-way ledger separating gas from protocol charges from payments
between participants.

```sh
cd web && npx vite-node tools/fleet.ts -- --orders 6 --lanes 2   # a rehearsal
```

It needs a funded key at `~/.config/porterage/deploy-key`. It registers venues on the **live**
registry and closes them again when it sweeps.

## Status

Running on testnet. All eleven contracts are deployed to Paseo Asset Hub and the app is published;
a hundred live orders ran end to end across every way an order can finish, and the two that failed
were a chain limit rather than a contract bug.

Not built: mainnet, a decentralised arbiter (disputes are ruled by a single key), personhood
(the gate exists and ships off), stake (`minStake` is 0), and any venue verification.
[docs/OVERVIEW.md §10](docs/OVERVIEW.md#10-what-is-not-built) is the honest list.

Porterage inherits the purpose, contracts, circuits and privacy work of
[FARE](https://github.com/Baronvonbonbon/fare). What the Polkadot app can and cannot do is measured
with [sonde](https://github.com/Baronvonbonbon/sonde) and recorded in
[polkadot-host-capabilities](https://github.com/Baronvonbonbon/polkadot-host-capabilities).

## Licence

[AGPL-3.0-or-later](LICENSE). Run a modified Porterage as a service and its users are entitled to
your source — the network clause matters here, because this is software people reach over a network
and would otherwise never be "distributed" at all.
