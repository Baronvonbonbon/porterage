# Porterage

Peer-to-peer delivery that lives entirely inside the Polkadot app. Customers, drivers and venues
deal directly: drivers bid for the fare in a sealed auction, and money moves only when the parties
whose interests conflict both sign.

Porterage inherits the purpose, contracts, circuits and privacy work of
[FARE](https://github.com/Baronvonbonbon/fare), and rebuilds them around what the Polkadot app gives
a Product, measured on a phone:

- **No required servers.** Polkadot primitives first: the Statement Store for signalling, WebRTC for
  chat, Bulletin for evidence and menus, host notifications. The relay FARE depended on is an
  optional convenience node.
- **Private by default.** Per-order customer burners funded through Kusama Shield, a sealed-bid
  auction, a zero-knowledge dropoff proof that keeps the address off-chain, and batched shielded
  payouts for drivers and venues.
- **Few taps.** Drivers and venues tap to approve rare actions; a session key the app keeps signs
  bids and handoffs.
- **No GPS needed.** Handoffs settle by QR and two signatures; GPS is added as evidence when the app
  allows it.

**How it works:** [docs/OVERVIEW.md](docs/OVERVIEW.md) — the whole system in one pass,
written for a person or a model coming to it cold.

**Status:** running on testnet. All eleven contracts are deployed to Paseo Asset Hub and the
app is published; a hundred live orders ran end to end across every way an order can finish.
[docs/PLAN.md](docs/PLAN.md) is the plan of record and [docs/DEPLOY.md](docs/DEPLOY.md) is the
log of what has actually shipped. What the platform can and
can't do is measured with [sonde](https://github.com/Baronvonbonbon/sonde) and recorded in
[polkadot-host-capabilities](https://github.com/Baronvonbonbon/polkadot-host-capabilities).

Testnet only (Paseo Asset Hub). [AGPL-3.0-or-later](LICENSE) — if you run a modified
Porterage as a service, its users are entitled to your source.
