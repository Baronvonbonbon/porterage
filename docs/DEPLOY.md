# Deploying Porterage

Two keys, both kept on this computer, never in the repo and never printed:

| Key | File | Does | Command |
|---|---|---|---|
| Contract deployer (Ethereum) | `~/.config/porterage/deploy-key` | Deploys and wires the contracts | `npm run deploy-key`, then `npm run deploy` |
| Name key (sr25519 mnemonic) | `~/.config/porterage/name-key` | Owns `porterage.dot` and sets what it points to | `npm run name-key`, then `npm run deploy:app` |

They are separate because pad signs sr25519 from a mnemonic, and the contracts
were deployed from an Ethereum key. The phone is not involved in either: pad's
phone signer is a hidden product account that has moved between key schemes and
stranded names before (sonde, 2026-09-18).

`npm run deploy:app` checks the key and the name, refuses if `PRODUCT_ID` in
`web/src/config.ts` differs from the label, runs the web tests and build, and
publishes `web/dist` with pad as a library. The name key signs DotNS; one of
pad's pool accounts signs the Bulletin upload. `--check` stops before anything is
signed. Registering an unowned label needs `--register` and the label typed back
(or `CONFIRM_LABEL=<label>.dot`).

## Record

| Date | What | Detail |
|---|---|---|
| 2026-09-19 | Contracts on Paseo Asset Hub | Deployer `0x4B38b09Fb2c7B5310f4f7D51d359Fc63a344c420`, about 9 PAS. Addresses in `deployed-addresses.json`. |
| 2026-09-19 | Registered `porterage.dot` | Owner: the name key, `5GVobt2azMJ3PjZxtc935wJJL3aDEM9cQoSU3C8d12ZrxVtu` / `0xc05764d1eea94660ec073ab288f5cd0bf5d85061`. 11 PAS paid. Funded with 20 PAS from sonde's deploy key. |
| 2026-09-19 | Published | `bafybeihmklscserz4j6pwpbwhhooktramdsfqopwuz62x5qtjjcmwodo6y`. The first run registered the name, but its contenthash step timed out after 300 s; the re-run set it. |
| 2026-09-19 | Published the private balance screen | `bafybeiewfiinn276mrigc22j53c3ubqhhh4umwplluvf67djozvs5hin5e` |
