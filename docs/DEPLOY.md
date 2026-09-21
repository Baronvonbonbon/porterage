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
| 2026-09-19 | Published withdrawals and the funding market, with the 32.8 MiB proving key | `bafybeicbqnb4d5awqi57cillg72drnfmrlhyxeo73bhav6xelhzacdhtfi`. 38.6 MB in 32 Bulletin chunks; the publish took 9 min 51 s. |
| 2026-09-19 | Wired shielded payouts and published them | Shield verifier deployed and keyed, vault pointed at Kusama Shield, Poseidon and the buckets; all 22 checks pass. App `bafybeigrpxwlcsuupapakqsnc7qi6y2wejk3mdagcftt3h6dak4hrcwebm` (8.1 MB incremental). |
| 2026-09-20 | Published token top-ups | `bafybeic4rvhmfgqar7lazji2d5x24jpmdr3lyz4a567j77ekwnkbvoceii` (1.5 MB incremental) |
| 2026-09-20 | Published ordering, venues and the auction | `bafybeif2e3e4rmjvfpaiuc5uszchc4wihvh2efzvv3vjf7p5jzbhzjiike` |
| 2026-09-20 | Published the QR handoffs and the proximity proof | `bafybeiaztukjm2b3rdfir6wd2iyfohjwvhpus6jxl5q2caomsgaxad464q` |
| 2026-09-20 | Published menus and photo evidence | `bafybeicefnhlydlxbxkxckqywpz4yog5k4yhssb4nexnhhay7j24nde6ne` |
| 2026-09-20 | Published the kitchen view | `bafybeicr7f34iysz3r6nv77ficonpxy5ayfzu6epqlgqr7ai42ps4whgce` |
| 2026-09-20 | Published the drop map, and buttons in place of dropdowns | `bafybeib2lzzmx5mj7vjhy3bydmhgwy5xd2les5zuxb5hphwwbyjg2lxs7a`. The app's WebView never opened `<select>` popups, so the venue and token lists couldn't be picked from on a phone. |
| 2026-09-20 | Published order messages | `bafybeigmc2cq5vncrwrjtvmmk5qiculiuqiawamwo4uruiebz7bnjlr2ne` |
| 2026-09-20 | Set the arbiter, published disputes and ratings | `bafybeid3puptsivrvxoxfdpwzcxq6rmxiss5simvvb6mu53lcie3qrob5e`. Arbiter = the deploy key `0x4B38…c420`; its public key is in `web/src/deployed.json` and the app refuses it unless it hashes to that address. Dispute bond 0 (bootstrap). |
| 2026-09-20 | Topped the deployer up | 120 PAS from the name key, in two transfers (`node tools/fund-deployer.mjs`). Live runs now refund their throwaway accounts, so one costs about 3.5 PAS instead of 30. |
| 2026-09-20 | Published the operations console | `bafybeig6l26y3o4utzieunckbcjjvl3cct3qik4xxz7pnymeqp7hdg4eei`. Read-only unless the device holds the arbiter key; `npx vite-node tools/ops.ts -- list \| show \| rule` is the arbiter's command line. |
| 2026-09-20 | Published live chat and notifications | `bafybeihhtroi3bp6jwpbd3xtgvskebb5air2tt7momctyzsceymfnqumxm`. `npm run test:rtc` checks the signalling rebuild against a real WebRTC stack. |
| 2026-09-20 | Published distance filtering | `bafybeia66uhny2pqkocs74jglbesixhy3q2utlz43suinbdheue5hpzbhq`. Saved pin never leaves the device; the opt-in drop area is a fixed ~1.1 km grid cell. |
| 2026-09-20 | Published thread archives | `bafybeie4opv7id6dcwyzav4fhjb4zo5nyvdkn56qdwfyz5lp4nqemwymuy`. A long conversation's transcript goes to Bulletin once per windowful, not per message. |
| 2026-09-20 | Published the drop hand-off | `bafybeia74t5ffmzn37xu5dilebflhqx6g7ntdzqjxt7oru6rsmnfmh2spu`. The chosen driver is sent the exact drop, sealed to it alone. |
| 2026-09-20 | Published directions | `bafybeibmmnyth46txr3spc6lj5xqqiocsrb5iigxcorz3vbtvhjamt2oma`. `geo:` through `navigateTo`, then a web map or the clipboard by choice. |
| 2026-09-20 | Published menu caching and venue labels | `bafybeifr3pmtpygxyn5mzrofds2kxzr5j3ogce5vukm24ota56snmrs7ri` |
| 2026-09-20 | Published the visual pass | `bafybeihvfjquhslmygvlmu3lc3oakqidt7cwhwmc3nareu7avegrn5drmi`. Type and space scale, tokens with dark values, marked primary actions, host theme followed. |
| 2026-09-20 | Published the picker module | `bafybeihdflnqtdgyoge5kjmb73m7biwwrv2iugebo2zlprnwef5j2jyigu`. One amount parser, presets, steppers, validation beside the field. |
| 2026-09-20 | Published the smaller items | `bafybeibd7ezbdy6ylpbwbqxcyjgqys75tzruejp47ekb4pv2qxk4vk6paa`. Order history, a "what happens next" line per role, half-failed sends retried when the order is reopened, the venue's rating and takings on one screen, and the privacy copy gathered into `copy/privacy.ts`. |
| 2026-09-20 | Published the phone probes | `bafybeih575ildphdbz54i5swwhfga25nwuln4z3dp2w2wpwukmwwqoyqby`. "Check this phone" under the role chooser: the four unmeasured questions, each as a run of a couple of minutes, with a report to paste back. |
