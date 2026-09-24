// Telling a busy chain apart from a contract saying no.
//
// `send` retries, and a retry of the wrong thing is worse than no retry at
// all: a genuine `require` failure would become three slow failures and the
// person would wait three times as long to be told the same thing. So the two
// directions matter equally, and both are tested here.
//
// The shapes below are not invented. The refusal is the receipt from order 63
// of the hundred-order fleet run on 2026-09-24 — mined, status 0, 1,905 gas,
// no reason at all. The reverts are what ethers hands back for the `require`
// messages these contracts actually carry.

import { describe, expect, it, vi } from "vitest";
import { isResourceRefusal, send } from "./send";

/** What the chain returned when it had no proof-size room left. */
const refusal = {
  message: "transaction execution reverted",
  receipt: { status: 0, gasUsed: 1905n },
};

/** What a contract returns when it means it. */
const revert = (reason: string, gasUsed = 21_744n) => ({
  reason,
  message: `execution reverted: "${reason}"`,
  data: "0x08c379a0",
  receipt: { status: 0, gasUsed },
});

describe("isResourceRefusal", () => {
  it("knows the refusal the fleet run hit", () => {
    expect(isResourceRefusal(refusal)).toBe(true);
  });

  it("knows a refusal the node states outright, before inclusion", () => {
    expect(
      isResourceRefusal({
        message:
          'Module(ModuleError { index: 100, error: [3,0,0,0], message: Some("OutOfGas") })',
      })
    ).toBe(true);
    expect(
      isResourceRefusal({ info: { error: { message: "proof size exhausted" } } })
    ).toBe(true);
  });

  it("leaves a real revert alone", () => {
    expect(isResourceRefusal(revert("not-customer"))).toBe(false);
    expect(isResourceRefusal(revert("bad-pickup-window"))).toBe(false);
  });

  // The case the two-signal rule exists for. A `require(false)` with no message
  // carries no reason either, and on its own that would look like a refusal.
  it("leaves a reasonless revert alone when it actually ran", () => {
    expect(
      isResourceRefusal({
        message: "execution reverted",
        receipt: { status: 0, gasUsed: 24_310n },
      })
    ).toBe(false);
  });

  // The other half of the rule. Trivial gas on a transaction that SUCCEEDED is
  // not a refusal, and neither is anything that is not an error object.
  it("leaves alone what is not a failed transaction", () => {
    expect(
      isResourceRefusal({ receipt: { status: 1, gasUsed: 1905n } })
    ).toBe(false);
    expect(isResourceRefusal(new Error("network is down"))).toBe(false);
    expect(isResourceRefusal(null)).toBe(false);
    expect(isResourceRefusal("OutOfGas")).toBe(false);
  });
});

const ok = (gasUsed = 21_008n) => ({
  wait: async () => ({ status: 1, gasUsed }),
});

describe("send", () => {
  it("builds the transaction afresh each attempt", async () => {
    // A refused transaction cannot be re-awaited: it has to be signed again.
    // So `send` takes a function, and this is the proof it calls it anew.
    let attempts = 0;
    const make = vi.fn(async () => {
      if (++attempts < 3) throw refusal;
      return ok() as never;
    });
    const onRetry = vi.fn();

    const rec = await send(make, { onRetry, backoffMs: 0 });

    expect(make).toHaveBeenCalledTimes(3);
    expect(onRetry.mock.calls).toEqual([[1], [2]]);
    expect(rec.status).toBe(1);
  });

  it("does not retry a contract that said no", async () => {
    const make = vi.fn(async () => {
      throw revert("not-customer");
    });
    await expect(send(make)).rejects.toMatchObject({ reason: "not-customer" });
    expect(make).toHaveBeenCalledTimes(1);
  });

  it("gives up, and gives back the chain's own error", async () => {
    const make = vi.fn(async () => {
      throw refusal;
    });
    await expect(send(make, { retries: 1, backoffMs: 0 })).rejects.toBe(refusal);
    expect(make).toHaveBeenCalledTimes(2);
  });

  it("sends once when the chain has room", async () => {
    const make = vi.fn(async () => ok() as never);
    await expect(send(make)).resolves.toMatchObject({ status: 1 });
    expect(make).toHaveBeenCalledTimes(1);
  });
});
