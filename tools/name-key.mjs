// The key that owns porterage.dot and signs its content updates, kept on this computer, so
// publishing the app needs no phone (the sonde and almanac pattern).
//
// Why not the phone: pad's phone signer is a product account the wallet derives and never reveals,
// and it moved when product-sdk-keys 0.4 changed the derivation. Two sonde names were stranded that
// way (sonde DEPLOY.md, 2026-09-18). A key held here cannot drift.
//
// This is a separate key from the contract deployer (tools/deploy-key.mjs): pad signs sr25519 from a
// mnemonic, and the contracts were deployed from an Ethereum key.
//
// The words are written once to KEY_FILE (mode 600, outside the repo) and never printed. Only the
// address to fund is shown.
//
// Usage, from the repo root:
//   npm run name-key                      create the key if there is none, and print its address
//   node tools/name-key.mjs --check       only check the derivation still matches pad's

import { keccak_256 } from "@noble/hashes/sha3.js";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
  DEV_PHRASE,
  entropyToMiniSecret,
  generateMnemonic,
  mnemonicToEntropy,
  ss58Address,
} from "@polkadot-labs/hdkd-helpers";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const KEY_FILE = process.env.PORTERAGE_NAME_KEY ?? join(homedir(), ".config", "porterage", "name-key");

/** The root sr25519 account of a mnemonic — no derivation path, as pad's keyring.addFromMnemonic uses it. */
export function accountOf(mnemonic) {
  const words = mnemonic.trim().split(/\s+/).join(" ");
  const { publicKey } = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(words)))("");
  // pallet-revive maps a non-Ethereum AccountId32 to the last 20 bytes of its keccak-256.
  const h160 = `0x${Buffer.from(keccak_256(publicKey).slice(12)).toString("hex")}`;
  return { ss58: ss58Address(publicKey), h160 };
}

// Checked against pad's own output: with its default key (the public dev phrase) its preflight prints
// SS58 5DfhGy… and H160 0x35cd… (again on 2026-09-18). If this derivation ever disagrees with pad's, the
// address shown for funding would be the wrong one — so refuse rather than print it.
const dev = accountOf(DEV_PHRASE);
if (dev.ss58 !== "5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV" || dev.h160 !== "0x35cdb23ff7fc86e8dccd577ca309bfea9c978d20") {
  throw new Error(`name-key: derivation no longer matches pad's (${dev.ss58} / ${dev.h160})`);
}

export function readKey() {
  return existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    console.log("name-key: derivation matches pad's");
    process.exit(0);
  }
  let mnemonic = readKey();
  if (mnemonic) {
    console.log(`Using the deploy key in ${KEY_FILE}.`);
  } else {
    mkdirSync(dirname(KEY_FILE), { recursive: true, mode: 0o700 });
    mnemonic = generateMnemonic(256);
    writeFileSync(KEY_FILE, `${mnemonic}\n`, { mode: 0o600, flag: "wx" });
    console.log(`Created a deploy key in ${KEY_FILE}, readable only by you. Its words are not shown.`);
  }
  const { ss58, h160 } = accountOf(mnemonic);
  console.log(`\n  Address  ${ss58}\n  H160     ${h160}\n`);
  console.log("Fund the address with test PAS on Paseo Asset Hub (faucet.polkadot.io). Registering a name costs about 10 PAS.");
  console.log("Back the key file up somewhere safe: it owns the .dot name.");
}
