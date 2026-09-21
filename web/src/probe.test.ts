import { beforeEach, describe, expect, it } from "vitest";
import {
  answer,
  asReport,
  beginning,
  forget,
  QUESTIONS,
  readBook,
  record,
} from "./probe";

// The probes run on a phone, but the bookkeeping that has to survive a phone
// navigating away from the app is ordinary code, and this is where it's held
// to account.
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

describe("phone probes", () => {
  beforeEach(() => {
    globalThis.localStorage = fakeStorage();
  });

  it("remember a probe that never came back", () => {
    // The whole point of writing before the risky call: if navigateTo takes
    // the WebView with it, this mark is all that's left.
    beginning("geo", "navigateTo(geo:…) called, no answer yet");
    expect(readBook().geo?.pending).toBe(true);

    // ...and a completed run clears it.
    record("geo", "navigateTo(geo:) → opened", 31);
    expect(readBook().geo).toMatchObject({
      measured: "navigateTo(geo:) → opened",
      ms: 31,
    });
    expect(readBook().geo?.pending).toBeUndefined();
  });

  it("keep what the code saw apart from what the person saw", () => {
    // A resolved promise is not a map app opening. The two never merge.
    record("geo", "navigateTo(geo:) → opened");
    answer("geo", "Nothing happened");
    const r = readBook().geo!;
    expect(r.measured).toBe("navigateTo(geo:) → opened");
    expect(r.answered).toBe("Nothing happened");
  });

  it("let the person answer a probe that died before recording anything", () => {
    beginning("geo", "called");
    answer("geo", "Porterage was replaced by something else");
    expect(readBook().geo).toMatchObject({
      answered: "Porterage was replaced by something else",
      pending: false,
    });
  });

  it("survive storage that isn't there", () => {
    // Private mode, blocked site data, a preview: the screen still has to run.
    globalThis.localStorage = {
      getItem: () => {
        throw new Error("nope");
      },
      setItem: () => {
        throw new Error("nope");
      },
    } as unknown as Storage;
    expect(readBook()).toEqual({});
    expect(() => record("bulletin", "two writes")).not.toThrow();
  });

  it("report every question, run or not, and say which never came back", () => {
    record("bulletin", "two writes: 900 ms then 120 ms", 1020);
    answer("bulletin", "One prompt");
    beginning("geo", "called");

    const text = asReport(readBook());
    for (const q of QUESTIONS) expect(text).toContain(q.asks);
    expect(text).toContain("saw: One prompt");
    expect(text).toContain("PENDING");
    expect(text).toContain("not run"); // the camera and notification probes
  });

  it("forget a probe so it can be run again from scratch", () => {
    record("camera", "scanned its own code");
    forget("camera");
    expect(readBook().camera).toBeUndefined();
  });

  it("say what each question decides, so none is busywork", () => {
    // A probe whose answer changes nothing isn't worth someone's minute.
    for (const q of QUESTIONS) {
      expect(q.decides.length).toBeGreaterThan(40);
      expect(q.choices.length).toBeGreaterThanOrEqual(2);
    }
  });
});
