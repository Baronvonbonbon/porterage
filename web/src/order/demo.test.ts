// The demo venues, and the line between them and a real shop.
//
// These ship inside the app because nothing outside the Polkadot app can write
// to Bulletin, and what is written there lasts about two weeks. That is a
// reasonable trade, but it puts a second source of menus into a resolver that
// had one, so the two must not be able to be mistaken for each other:
//
//   - a demo menu is always marked, and the mark comes from the URI it was
//     asked for, not from anything inside the document. A published menu
//     cannot award itself the badge by writing `"demo": true`, and a demo one
//     cannot shed it.
//   - a slug is a key into a fixed table, never a path, so `demo:` cannot be
//     pointed at anything else the bundle happens to contain.
//
// The rest is the promise that these are removable, which is only worth
// anything if the documents are real ones: they go through `decodeMenu`, the
// same function a Bulletin document does, so a demo menu that stopped parsing
// would fail here rather than in someone's hands.

import { describe, expect, it, vi } from "vitest";

const got = vi.fn(async (_key: string): Promise<Uint8Array | null> => null);
vi.mock("../host", () => ({ hostGet: (k: string) => got(k), hostPut: vi.fn() }));
// The menu cache lives here, not in a module called "store" — a mock on the
// wrong path is a test that passes for the wrong reason.
vi.mock("../shield/notes", () => ({
  cachedMenu: async () => null,
  cacheMenu: async () => undefined,
}));

const { menuOf, encodeMenu } = await import("./menu");
const table = (await import("./demo.json")).default as Record<string, unknown>;

describe("the demo set", () => {
  it("ships five venues, each a document decodeMenu accepts", async () => {
    const slugs = Object.keys(table);
    expect(slugs).toHaveLength(5);
    for (const slug of slugs) {
      const menu = await menuOf(`demo:${slug}`);
      expect(menu, slug).not.toBeNull();
      expect(menu!.name.length, slug).toBeGreaterThan(0);
      expect(menu!.items.length, slug).toBeGreaterThan(0);
      // Prices are wei, as a venue publishes them, not a decimal that would
      // silently become a thousandth of the intended price.
      for (const i of menu!.items) expect(typeof i.price).toBe("bigint");
    }
  });

  it("carries its picture inline, so there is nothing to fetch", async () => {
    const menu = await menuOf("demo:noon-bakehouse");
    expect(menu!.photo).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(got).not.toHaveBeenCalled();
  });

  it("marks every one of them", async () => {
    for (const slug of Object.keys(table))
      expect((await menuOf(`demo:${slug}`))!.demo, slug).toBe(true);
  });

  it("does not let a published menu claim to be one", async () => {
    // The document says it is a demo. The URI says otherwise, and the URI wins.
    const doc = JSON.parse(
      new TextDecoder().decode(
        encodeMenu({ name: "Not A Demo", items: [], demo: true })
      )
    );
    got.mockResolvedValueOnce(
      new TextEncoder().encode(JSON.stringify({ ...doc, demo: true }))
    );
    const menu = await menuOf("bulletin:abc123");
    expect(menu!.name).toBe("Not A Demo");
    expect(menu!.demo).toBeUndefined();
  });

  it("treats the slug as a key, never a path", async () => {
    expect(await menuOf("demo:../deployed")).toBeNull();
    expect(await menuOf("demo:")).toBeNull();
    expect(await menuOf("demo:nothing-by-that-name")).toBeNull();
  });

  it("leaves a URI it does not recognise alone", async () => {
    expect(await menuOf("fixtures/profiles/venue-thistle-ash.svg")).toBeNull();
    expect(await menuOf("")).toBeNull();
  });
});
