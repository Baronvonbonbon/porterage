// Every transaction this app sends with its own key goes through `writable`.
//
// This exists because of a bug a driver hit on a real phone: tapping Bid died
// with `missing provider (operation="sendTransaction")`. The session key is
// derived in `keys.ts` with `new Wallet(hex)`, which can sign but cannot send;
// `Driver.tsx` held it in state and passed it down to `placeBid`, and nothing
// along the way connected it to a provider. Bidding, confirming a pickup and
// committing evidence were all broken the same way, and none of it showed up
// in a type error — a `Wallet` without a provider is still a `Wallet`.
//
// So the first test pins the behaviour, and the second is the one that
// actually keeps this fixed: it reads the source and fails if a signer-bound
// contract is ever built without going through `writable`. A unit test on a
// helper cannot notice a seventh call site that skips the helper.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Wallet } from "ethers";
import { writable } from "./contracts";

describe("writable", () => {
  it("connects a provider-less wallet, which is what keys.ts hands out", () => {
    const bare = new Wallet(Wallet.createRandom().privateKey);
    expect(bare.provider).toBe(null);
    expect(writable(bare).provider).not.toBe(null);
  });

  it("keeps the key the same — connecting must not change who signs", () => {
    const bare = new Wallet(Wallet.createRandom().privateKey);
    expect(writable(bare).address).toBe(bare.address);
  });

  it("leaves an already-connected signer alone", () => {
    const bare = new Wallet(Wallet.createRandom().privateKey);
    const once = writable(bare);
    expect(writable(once)).toBe(once);
  });
});

/** Every .ts/.tsx under src, so a new call site cannot hide in a new folder. */
function sources(dir: string, found: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) sources(path, found);
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".test.ts"))
      found.push(path);
  }
  return found;
}

/**
 * Runners that are fine as they stand, each because it cannot be a bare wallet.
 * Keyed `file::runner`, so adding a new one is a deliberate act with a reason
 * next to it rather than a silent widening of the rule.
 */
const REVIEWED: Record<string, string> = {
  // Typed `Provider`: read-only by construction, nothing to send with.
  "src/shield/pool.ts::provider": "typed Provider, read-only",
  "src/shield/payout.ts::provider": "typed Provider, read-only",
  // Typed `Signer` from the funding market, and it already dereferences
  // `signer.provider!` for gas, so a disconnected one cannot get this far.
  // Its callers in shield/fund.ts connect the burner before handing it over.
  "src/market/submit.ts::signer": "typed Signer, provider asserted for fee data",
};

describe("no signer-bound contract skips writable", () => {
  it("every `new Contract(...)` runner is a provider, connected, or writable()", () => {
    const offenders: string[] = [];
    for (const file of sources(join(__dirname))) {
      const text = readFileSync(file, "utf8");
      // `new Contract(addr, abi, X)` — the third argument is the runner.
      const calls = text.matchAll(
        /new Contract\(\s*[^;]*?,\s*([A-Za-z0-9_.()]+)\s*\)/g
      );
      const where = file.replace(__dirname, "src");
      for (const m of calls) {
        const runner = m[1].trim();
        if (
          runner === "ethProvider()" ||
          runner.startsWith("writable(") ||
          runner.includes(".connect(") ||
          REVIEWED[`${where}::${runner}`]
        )
          continue;
        offenders.push(`${where}: runner \`${runner}\``);
      }
    }
    expect(
      offenders,
      `these build a contract with a runner that is not ethProvider(), not ` +
        `writable(...), not explicitly .connect()ed, and not in REVIEWED. ` +
        `If it can be a wallet from keys.ts it has no provider, and a phone ` +
        `will fail with "missing provider" at the worst possible moment — ` +
        `wrap it in writable(). If it genuinely cannot, add it to REVIEWED ` +
        `with the reason:\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});
