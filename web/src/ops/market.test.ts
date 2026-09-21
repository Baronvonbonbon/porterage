// Telling the three failures apart.
//
// "No one has submitted the request yet" is true whether nobody is running a
// helper, the fee is too low for the ones who are, or this one request is
// being refused on its merits. Those need three different responses, so the
// verdict has to distinguish them or it is no better than the message it
// replaces.

import { describe, expect, it } from "vitest";
import { emptyHealth, verdict, type Health, type Posted } from "./market";

const post = (over: Partial<Posted> = {}): Posted => ({
  recipient: "0x" + "1".repeat(40),
  amount: 10n ** 18n,
  seenAt: Date.now(),
  offering: 10n ** 17n,
  ...over,
});

const health = (over: Partial<Health> = {}): Health => ({
  ...emptyHealth(),
  ...over,
});

describe("reading the market", () => {
  it("says nothing either way when it has seen nothing", () => {
    // The honest answer to an empty screen. Claiming the market is healthy
    // because nothing has failed would be the worst of the four.
    const v = verdict(emptyHealth());
    expect(v.tone).toBe("muted");
    expect(v.text).toContain("says nothing either way");
  });

  it("calls it broken when requests pile up and nothing clears", () => {
    const v = verdict(health({ waiting: [post(), post()] }));
    expect(v.tone).toBe("error");
    expect(v.text).toContain("2 requests");
    // Names both causes, because the operator's next step differs.
    expect(v.text).toContain("nobody is running a helper");
    expect(v.text).toContain("covering their gas");
  });

  it("singles out one stuck request when others are clearing", () => {
    // This is the case that used to be indistinguishable: the market is fine,
    // that request is not.
    const v = verdict(
      health({
        waiting: [post({ seenAt: Date.now() - 300_000 })],
        cleared: [post({ clearedAt: Date.now(), clearedBy: "0xabc" })],
        submitters: ["0xabc"],
        oldestWaitingS: 300,
      })
    );
    expect(v.tone).toBe("warn");
    expect(v.text).toContain("probably being refused");
  });

  it("is content when things clear promptly", () => {
    const v = verdict(
      health({
        cleared: [post({ clearedAt: Date.now(), clearedBy: "0xabc" })],
        submitters: ["0xabc"],
        medianWaitS: 8,
      })
    );
    expect(v.tone).toBe("ok");
    expect(v.text).toContain("1 cleared");
    expect(v.text).toContain("1 distinct submitter");
    expect(v.text).toContain("8 s");
  });

  it("pluralises submitters, because a one-submitter market is worth noticing", () => {
    const one = verdict(
      health({ cleared: [post({ clearedAt: 1 })], submitters: ["0xa"] })
    );
    expect(one.text).toContain("1 distinct submitter.");
    const two = verdict(
      health({ cleared: [post({ clearedAt: 1 })], submitters: ["0xa", "0xb"] })
    );
    expect(two.text).toContain("2 distinct submitters");
  });

  it("does not cry stuck over a request that has only just gone up", () => {
    // A few seconds of waiting is the normal case, not an incident.
    const v = verdict(
      health({
        waiting: [post()],
        cleared: [post({ clearedAt: Date.now() })],
        submitters: ["0xabc"],
        oldestWaitingS: 5,
      })
    );
    expect(v.tone).toBe("ok");
  });
});
