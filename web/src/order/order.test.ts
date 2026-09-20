import { describe, expect, it } from "vitest";
import { Wallet, hexlify } from "ethers";
import { decodeAnnounce, encodeAnnounce, openSealed, sealOpening } from "./bids";
import { formatDegrees, metresBetween, parseDegrees, positionCommit, randomSalt } from "./geo";

describe("positions", () => {
  it("read and write degrees as microdegrees", () => {
    expect(parseDegrees("37.7749")).toBe(37_774_900);
    expect(parseDegrees("-122.419400")).toBe(-122_419_400);
    expect(parseDegrees("")).toBe(null);
    expect(parseDegrees("north")).toBe(null);
    expect(formatDegrees(37_774_900)).toBe("37.774900");
  });

  it("commit to a position without revealing it, and differ by salt", () => {
    const at = { lat: 37_774_900, lon: -122_419_400 };
    const salt = randomSalt();
    expect(positionCommit(at, salt)).toBe(positionCommit(at, salt));
    expect(positionCommit(at, salt)).not.toBe(positionCommit(at, randomSalt()));
    expect(positionCommit(at, salt)).not.toBe(positionCommit({ ...at, lat: at.lat + 1 }, salt));
  });

  it("measure a distance", () => {
    expect(metresBetween({ lat: 37_774_900, lon: -122_419_400 }, { lat: 37_784_900, lon: -122_419_400 })).toBe(1113);
  });
});

describe("sealed bids", () => {
  it("announce the key a bidder encrypts to", () => {
    const customer = Wallet.createRandom();
    const bytes = encodeAnnounce(customer.signingKey.publicKey);
    expect(bytes.length).toBe(35);
    expect(decodeAnnounce(bytes)).toBe(hexlify(customer.signingKey.compressedPublicKey));
    expect(decodeAnnounce(new Uint8Array(35))).toBe(null);
  });

  it("only the customer can read an opening", async () => {
    const customer = Wallet.createRandom();
    const stranger = Wallet.createRandom();
    const driver = Wallet.createRandom();
    const opening = { driver: driver.address.toLowerCase(), amount: 1_500_000_000_000_000_000n, salt: hexlify(new Uint8Array(32).fill(7)) };

    const sealed = await sealOpening(customer.signingKey.publicKey, opening);
    expect(sealed.length).toBeLessThanOrEqual(200);
    expect(await openSealed(customer, sealed)).toEqual(opening);
    expect(await openSealed(stranger, sealed)).toBe(null);
  });

  it("two bids on the same terms look different", async () => {
    const customer = Wallet.createRandom();
    const opening = { driver: Wallet.createRandom().address.toLowerCase(), amount: 1n, salt: hexlify(new Uint8Array(32)) };
    const a = await sealOpening(customer.signingKey.publicKey, opening);
    const b = await sealOpening(customer.signingKey.publicKey, opening);
    expect(hexlify(a)).not.toBe(hexlify(b));
  });
});

import { decodePayload, encodeDropRequest, encodeDropSignature, encodePickup, makeDropRequest } from "./handoff";

describe("handoff codes", () => {
  const signature = hexlify(new Uint8Array(65).fill(3));

  it("carry a pickup in about 120 characters", () => {
    const p = { orderId: 42n, at: { lat: 37_774_900, lon: -122_419_400 }, timestamp: 1_800_000_000n, signature };
    const text = encodePickup(p);
    expect(text.length).toBeLessThan(140);
    expect(decodePayload(text)).toEqual({ kind: "pickup", ...p });
  });

  it("carry a door request with no coordinate in it", () => {
    const drop = { lat: 37_784_900, lon: -122_419_400 };
    const req = makeDropRequest(7n, drop);
    const text = encodeDropRequest(req.payload);
    expect(decodePayload(text)).toEqual({ kind: "dropRequest", ...req.payload });
    // The salt and the position are only on the phone that made it.
    const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
    expect(raw).not.toContain(String(drop.lat));
    expect(req.driverSalt).toBeGreaterThan(0n);
  });

  it("carry the driver's reply", () => {
    const p = { orderId: 7n, timestamp: 1_800_000_123n, signature };
    expect(decodePayload(encodeDropSignature(p))).toEqual({ kind: "dropSignature", ...p });
  });

  it("refuse anything else", () => {
    expect(() => decodePayload("hello")).toThrow();
    expect(() => decodePayload("")).toThrow();
    // A code of the right shape but the wrong kind still decodes as its own kind.
    expect(decodePayload(encodeDropSignature({ orderId: 1n, timestamp: 1n, signature })).kind).toBe("dropSignature");
  });
});

import { SigningKey } from "ethers";
import { basketText, basketTotal, decodeMenu, encodeMenu } from "./menu";
import { openPhoto, sealPhoto } from "./evidence";

describe("menus", () => {
  const menu = {
    name: "Corner counter",
    items: [
      { id: "a", name: "Coffee", price: 10n ** 18n },
      { id: "b", name: "Bun", price: 5n * 10n ** 17n },
    ],
  };

  it("survive a trip through Bulletin", () => {
    const bytes = encodeMenu(menu);
    expect(bytes.length).toBeLessThan(512);
    expect(decodeMenu(bytes)).toEqual(menu);
    expect(() => decodeMenu(new TextEncoder().encode("{}"))).toThrow();
  });

  it("total a basket", () => {
    const picked = new Map([["a", 2], ["b", 1]]);
    expect(basketTotal(menu, picked)).toBe(25n * 10n ** 17n);
    expect(basketText(menu, picked)).toBe("2× Coffee, 1× Bun");
    expect(basketTotal(menu, new Map())).toBe(0n);
  });
});

describe("delivery photos", () => {
  it("open for the two parties and nobody else", async () => {
    const driver = new SigningKey(hexlify(new Uint8Array(32).fill(5)));
    const customer = new SigningKey(hexlify(new Uint8Array(32).fill(9)));
    const stranger = new SigningKey(hexlify(new Uint8Array(32).fill(11)));
    const photo = new Uint8Array(64).fill(200);

    const sealed = await sealPhoto(driver, customer.publicKey, photo);
    expect(sealed.length).toBeGreaterThan(photo.length); // nonce and tag
    expect(await openPhoto(customer, driver.publicKey, sealed)).toEqual(photo);
    await expect(openPhoto(stranger, driver.publicKey, sealed)).rejects.toThrow();
  });
});
