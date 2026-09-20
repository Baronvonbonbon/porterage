import { beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, toUtf8Bytes, getBytes } from "ethers";

// Inside the Polkadot app, keys come from the host's deriveEntropy, which is
// deterministic per product. Stand in for it with a keyed hash so the tests can
// check what matters: same label → same key, different label → different key,
// and every purpose namespaced.
const hostEntropy = vi.fn(async (input: Uint8Array) => ({
  ok: true,
  value: getBytes(keccak256(input)),
}));
let inside = true;

vi.mock("@parity/product-sdk-host", () => ({
  deriveEntropy: (i: Uint8Array) => hostEntropy(i),
}));
vi.mock("./host", () => ({
  inHost: async () => inside,
  withTimeout: <T>(p: Promise<T>) => p,
}));

const keys = await import("./keys");

describe("keys", () => {
  beforeEach(() => {
    keys._resetKeysForTests();
    hostEntropy.mockClear();
    inside = true;
  });

  it("asks the host, with the namespaced label", async () => {
    await keys.sessionKey(0);
    expect(hostEntropy).toHaveBeenCalledWith(
      toUtf8Bytes("porterage:session:0")
    );
    expect(await keys.keySource()).toBe("host");
  });

  it("recomputes the same key from the same label", async () => {
    expect((await keys.sessionKey(3)).address).toBe(
      (await keys.sessionKey(3)).address
    );
    expect((await keys.burner(7)).address).toBe((await keys.burner(7)).address);
  });

  it("gives every epoch, every order and every purpose its own key", async () => {
    const all = [
      await keys.sessionKey(0),
      await keys.sessionKey(1),
      await keys.burner(0),
      await keys.burner(1),
    ].map((w) => w.address);
    expect(new Set(all).size).toBe(all.length);
  });

  it("refuses to continue when the host refuses", async () => {
    hostEntropy.mockResolvedValueOnce({
      ok: false,
      value: undefined as never,
      error: "denied",
    } as never);
    await expect(keys.sessionKey(0)).rejects.toThrow(/key derivation failed/);
  });

  it("outside the app, falls back to a browser seed and says so", async () => {
    inside = false;
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    });
    expect(await keys.keySource()).toBe("browser");
    const a = await keys.sessionKey(0);
    const b = await keys.sessionKey(0);
    expect(a.address).toBe(b.address);
    expect(hostEntropy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("walletFrom turns any 32 bytes into a valid key, even zero", () => {
    expect(keys.walletFrom(new Uint8Array(32)).address).toMatch(
      /^0x[0-9a-fA-F]{40}$/
    );
  });
});
