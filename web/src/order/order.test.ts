import { describe, expect, it } from "vitest";
import { dropsFrom, encodeArchive } from "./chat";
import { Wallet, hexlify, toUtf8String } from "ethers";
import {
  decodeAnnounce,
  encodeAnnounce,
  openSealed,
  sealOpening,
} from "./bids";
import {
  formatDegrees,
  metresBetween,
  parseDegrees,
  positionCommit,
  randomSalt,
} from "./geo";
import { TILE, latToY, lonToX, panned, wrapX, xToLon, yToLat } from "./tiles";
import { openWithKey, photoKeyOf } from "./evidence";
import { decodeCase, encodeCase } from "./dispute";
import { ratingText } from "./ratings";
import {
  CELL,
  cellOf,
  cellVagueness,
  cellWidth,
  decodeArea,
  encodeArea,
} from "./area";
import { decodeSignal, encodeSignal, readSdp, writeSdp } from "./live";
import { slashExceedsStake, splitEscrow } from "../ops/ruling";
import {
  MAX_TEXT,
  clip,
  decodeIntro,
  decodeThread,
  encodeIntro,
  encodeThread,
  sideChannel,
  threadTopic,
} from "./chat";

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
    expect(positionCommit(at, salt)).not.toBe(
      positionCommit({ ...at, lat: at.lat + 1 }, salt)
    );
  });

  it("measure a distance", () => {
    expect(
      metresBetween(
        { lat: 37_774_900, lon: -122_419_400 },
        { lat: 37_784_900, lon: -122_419_400 }
      )
    ).toBe(1113);
  });
});

describe("sealed bids", () => {
  it("announce the key a bidder encrypts to", () => {
    const customer = Wallet.createRandom();
    const bytes = encodeAnnounce(customer.signingKey.publicKey);
    expect(bytes.length).toBe(35);
    expect(decodeAnnounce(bytes)).toBe(
      hexlify(customer.signingKey.compressedPublicKey)
    );
    expect(decodeAnnounce(new Uint8Array(35))).toBe(null);
  });

  it("only the customer can read an opening", async () => {
    const customer = Wallet.createRandom();
    const stranger = Wallet.createRandom();
    const driver = Wallet.createRandom();
    const opening = {
      driver: driver.address.toLowerCase(),
      amount: 1_500_000_000_000_000_000n,
      salt: hexlify(new Uint8Array(32).fill(7)),
    };

    const sealed = await sealOpening(customer.signingKey.publicKey, opening);
    expect(sealed.length).toBeLessThanOrEqual(200);
    expect(await openSealed(customer, sealed)).toEqual(opening);
    expect(await openSealed(stranger, sealed)).toBe(null);
  });

  it("two bids on the same terms look different", async () => {
    const customer = Wallet.createRandom();
    const opening = {
      driver: Wallet.createRandom().address.toLowerCase(),
      amount: 1n,
      salt: hexlify(new Uint8Array(32)),
    };
    const a = await sealOpening(customer.signingKey.publicKey, opening);
    const b = await sealOpening(customer.signingKey.publicKey, opening);
    expect(hexlify(a)).not.toBe(hexlify(b));
  });
});

import {
  decodePayload,
  encodeDropRequest,
  encodeDropSignature,
  encodePickup,
  makeDropRequest,
} from "./handoff";

describe("handoff codes", () => {
  const signature = hexlify(new Uint8Array(65).fill(3));

  it("carry a pickup in about 120 characters", () => {
    const p = {
      orderId: 42n,
      at: { lat: 37_774_900, lon: -122_419_400 },
      timestamp: 1_800_000_000n,
      signature,
    };
    const text = encodePickup(p);
    expect(text.length).toBeLessThan(140);
    expect(decodePayload(text)).toEqual({ kind: "pickup", ...p });
  });

  it("carry a door request with no coordinate in it", () => {
    const drop = { lat: 37_784_900, lon: -122_419_400 };
    const req = makeDropRequest(7n, drop);
    const text = encodeDropRequest(req.payload);
    expect(decodePayload(text)).toEqual({
      kind: "dropRequest",
      ...req.payload,
    });
    // The salt and the position are only on the phone that made it.
    const raw = atob(
      text
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(text.length / 4) * 4, "=")
    );
    expect(raw).not.toContain(String(drop.lat));
    expect(req.driverSalt).toBeGreaterThan(0n);
  });

  it("carry the driver's reply", () => {
    const p = { orderId: 7n, timestamp: 1_800_000_123n, signature };
    expect(decodePayload(encodeDropSignature(p))).toEqual({
      kind: "dropSignature",
      ...p,
    });
  });

  it("refuse anything else", () => {
    expect(() => decodePayload("hello")).toThrow();
    expect(() => decodePayload("")).toThrow();
    // A code of the right shape but the wrong kind still decodes as its own kind.
    expect(
      decodePayload(
        encodeDropSignature({ orderId: 1n, timestamp: 1n, signature })
      ).kind
    ).toBe("dropSignature");
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
    const picked = new Map([
      ["a", 2],
      ["b", 1],
    ]);
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
    await expect(
      openPhoto(stranger, driver.publicKey, sealed)
    ).rejects.toThrow();
  });
});

import { decodeBasket, encodeBasket, basketLine } from "./kitchen";
import { open as openEnvelope, seal } from "./seal";

describe("baskets", () => {
  const basket = {
    orderId: 42n,
    items: new Map([
      ["a", 2],
      ["b", 1],
      ["c", 0],
    ]),
  };

  it("pack an order's items into a few bytes", () => {
    const bytes = encodeBasket(basket);
    expect(bytes.length).toBe(12); // 8 for the order, 2 per item picked
    const back = decodeBasket(bytes)!;
    expect(back.orderId).toBe(42n);
    expect([...back.items]).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
    expect(decodeBasket(new Uint8Array(3))).toBe(null);
  });

  it("read as a line for the counter", () => {
    const menu = {
      name: "x",
      items: [
        { id: "a", name: "Coffee", price: 1n },
        { id: "b", name: "Bun", price: 1n },
      ],
    };
    expect(basketLine(menu, basket)).toBe("2× Coffee, 1× Bun");
    expect(basketLine(null, basket)).toBe("2× a, 1× b");
  });

  it("only the counter can read one", async () => {
    const counter = new SigningKey(hexlify(new Uint8Array(32).fill(13)));
    const stranger = new SigningKey(hexlify(new Uint8Array(32).fill(17)));
    const sealed = await seal(
      counter.compressedPublicKey,
      5,
      encodeBasket(basket)
    );
    expect(await openEnvelope({ signingKey: counter }, 5, sealed)).toEqual(
      encodeBasket(basket)
    );
    expect(await openEnvelope({ signingKey: stranger }, 5, sealed)).toBe(null);
    // A different kind of envelope is not this one.
    expect(await openEnvelope({ signingKey: counter }, 4, sealed)).toBe(null);
  });
});

describe("map tiles", () => {
  it("project a position to a tile and back", () => {
    // The Greenwich observatory, on the prime meridian: at any zoom the world's
    // width is 2^z tiles, so longitude 0 sits exactly halfway across.
    for (const z of [13, 16, 18]) {
      expect(lonToX(0, z)).toBeCloseTo(2 ** z / 2, 9);
      expect(latToY(0, z)).toBeCloseTo(2 ** z / 2, 9);
    }
    for (const p of [
      { lat: 51.4779, lon: -0.0015 },
      { lat: -33.8688, lon: 151.2093 },
      { lat: 37.7749, lon: -122.4194 },
    ]) {
      const z = 17;
      expect(xToLon(lonToX(p.lon, z), z)).toBeCloseTo(p.lon, 9);
      expect(yToLat(latToY(p.lat, z), z)).toBeCloseTo(p.lat, 9);
    }
  });

  it("wrap tile columns round the date line", () => {
    expect(wrapX(-1, 4)).toBe(15);
    expect(wrapX(16, 4)).toBe(0);
    expect(wrapX(3, 4)).toBe(3);
  });

  it("pan by pixels, with a whole tile moving a tile's worth of degrees", () => {
    const z = 16;
    const centre = { lat: 37_774_900, lon: -122_419_400 };
    // Dragging the map right moves the pin west, by exactly one tile's width.
    const west = panned(centre, TILE, 0, z);
    expect(xToLon(lonToX(centre.lon / 1e6, z) - 1, z)).toBeCloseTo(
      west.lon / 1e6,
      5
    );
    expect(west.lat).toBe(centre.lat);
    // And a drag back returns to where it started, near enough to a microdegree.
    const back = panned(west, -TILE, 0, z);
    expect(Math.abs(back.lon - centre.lon)).toBeLessThanOrEqual(1);
    // A few hundred pixels at zoom 16 is a walkable distance, not a city away.
    const down = panned(centre, 0, -200, z);
    expect(metresBetween(centre, down)).toBeGreaterThan(100);
    expect(metresBetween(centre, down)).toBeLessThan(1000);
  });
});

describe("order messages", () => {
  const alice = new SigningKey(hexlify(new Uint8Array(32).fill(5)));
  const bob = new SigningKey(hexlify(new Uint8Array(32).fill(7)));
  const eve = new SigningKey(hexlify(new Uint8Array(32).fill(9)));

  it("both sides find the same thread, and nobody else can", () => {
    const ours = threadTopic(alice, bob.compressedPublicKey);
    expect(threadTopic(bob, alice.compressedPublicKey)).toBe(ours);
    // Eve knows both public keys and still can't derive it.
    expect(threadTopic(eve, alice.compressedPublicKey)).not.toBe(ours);
    expect(threadTopic(eve, bob.compressedPublicKey)).not.toBe(ours);
    // Each side writes to its own slot, so neither overwrites the other.
    expect(sideChannel(ours, alice)).not.toBe(sideChannel(ours, bob));
  });

  it("carry an introduction with the order, the role and the key", () => {
    const bytes = encodeIntro(9n, bob.publicKey, "driver");
    expect(bytes.length).toBe(42);
    const back = decodeIntro(bytes)!;
    expect(back.orderId).toBe(9n);
    expect(back.role).toBe("driver");
    expect(back.publicKey).toBe(bob.compressedPublicKey);
    expect(decodeIntro(bytes.slice(0, 41))).toBe(null);
  });

  it("round-trip a window of messages", () => {
    const said = [
      { at: 1_758_300_000_000, text: "at the gate" },
      {
        at: 1_758_300_060_000,
        text: "leave it by the door — the dog is friendly 🐕",
      },
    ];
    const back = decodeThread(encodeThread(7n, said))!;
    expect(back.orderId).toBe(7n);
    expect(back.said.map((m) => m.text)).toEqual(said.map((m) => m.text));
    // Seconds on the wire, so times come back to the second.
    expect(back.said[0].at).toBe(1_758_300_000_000);
    expect(decodeThread(new Uint8Array(4))).toBe(null);
  });

  it("drop the oldest messages rather than overflow a statement", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      at: 1_758_300_000_000 + i * 1000,
      text: `message ${i} `.repeat(3),
    }));
    const bytes = encodeThread(1n, many);
    expect(bytes.length).toBeLessThanOrEqual(448);
    const back = decodeThread(bytes)!;
    // The recent tail survives; the start is gone.
    expect(back.said.at(-1)!.text).toBe(many.at(-1)!.text);
    expect(back.said.length).toBeLessThan(many.length);
    expect(back.said[0].text).toBe(many[many.length - back.said.length].text);
  });

  it("stay readable at the longest message, and sealed to nobody else", async () => {
    // Every character here is two bytes, so 120 of them is 240 — inside the
    // length byte, which counting characters alone would have burst.
    const long = [{ at: Date.now(), text: "é".repeat(MAX_TEXT) }];
    expect(encodeThread(1n, long).length).toBeLessThanOrEqual(448);
    const sealed = await seal(
      bob.compressedPublicKey,
      7,
      encodeThread(1n, long)
    );
    expect(sealed.length).toBeLessThanOrEqual(512);
    expect(
      decodeThread((await openEnvelope({ signingKey: bob }, 7, sealed))!)!
        .said[0].text
    ).toBe(long[0].text);
    expect(await openEnvelope({ signingKey: eve }, 7, sealed)).toBe(null);
  });

  it("clip by bytes, not characters, without splitting one", () => {
    // 100 four-byte emoji are 400 bytes: too many for a length byte.
    const body = clip("🐕".repeat(100));
    expect(body.length).toBeLessThanOrEqual(255);
    expect(toUtf8String(body)).toBe("🐕".repeat(63)); // whole dogs only
  });
});

describe("evidence and disputes", () => {
  const driver = new SigningKey(hexlify(new Uint8Array(32).fill(21)));
  const customer = new SigningKey(hexlify(new Uint8Array(32).fill(22)));
  const arbiter = new SigningKey(hexlify(new Uint8Array(32).fill(23)));
  const photo = new Uint8Array(512).fill(200);

  it("give an arbiter the photo without giving it an identity key", async () => {
    const sealed = await sealPhoto(driver, customer.compressedPublicKey, photo);
    // Either party can unwrap the photo's own key.
    const key = await photoKeyOf(customer, driver.compressedPublicKey, sealed);
    expect([
      ...(await photoKeyOf(driver, customer.compressedPublicKey, sealed)),
    ]).toEqual([...key]);
    // That key opens this photo — and it's all the arbiter ever gets.
    expect([...(await openWithKey(key, sealed))]).toEqual([...photo]);
    // A second photo between the same two has a different key, so handing one
    // over doesn't open the other.
    const second = await sealPhoto(driver, customer.compressedPublicKey, photo);
    await expect(openWithKey(key, second)).rejects.toThrow();
  });

  it("seal a case to the arbiter alone", async () => {
    const photoKey = await photoKeyOf(
      driver,
      customer.compressedPublicKey,
      await sealPhoto(driver, customer.compressedPublicKey, photo)
    );
    const filed = encodeCase({
      reason: "Never arrived — the photo is of someone else's door.",
      photoKey,
    });
    const sealed = await seal(arbiter.compressedPublicKey, 8, filed);
    const back = decodeCase(
      (await openEnvelope({ signingKey: arbiter }, 8, sealed))!
    )!;
    expect(back.reason).toBe(
      "Never arrived — the photo is of someone else's door."
    );
    expect([...back.photoKey!]).toEqual([...photoKey]);
    // The driver being complained about can't read the complaint.
    expect(await openEnvelope({ signingKey: driver }, 8, sealed)).toBe(null);
  });

  it("read a case with no photo, and refuse a malformed one", () => {
    const back = decodeCase(encodeCase({ reason: "Cold." }))!;
    expect(back.reason).toBe("Cold.");
    expect(back.photoKey).toBe(undefined);
    expect(decodeCase(new Uint8Array(0))).toBe(null);
    expect(decodeCase(new Uint8Array([9, 1, 2]))).toBe(null); // says nine bytes, carries two
    expect(decodeCase(new Uint8Array([0, ...new Uint8Array(7)]))).toBe(null); // a key that isn't 32 bytes
  });

  it("read a rating back as text, including when there is none", () => {
    expect(ratingText({ avgX100: 437, count: 7 })).toBe("4.4★ from 7");
    expect(ratingText({ avgX100: 0, count: 0 })).toBe("not rated yet");
    expect(ratingText(null)).toBe("not rated yet");
  });
});

describe("ruling arithmetic", () => {
  const escrow = 2_500_000_000_000_000_001n; // deliberately not divisible

  it("split the escrow exactly as the contract does", () => {
    const { customerAmt, driverAmt } = splitEscrow(escrow, 7500);
    expect(customerAmt).toBe((escrow * 7500n) / 10_000n);
    // Nothing is stranded: the driver takes the truncation remainder.
    expect(customerAmt + driverAmt).toBe(escrow);
    expect(splitEscrow(escrow, 0)).toEqual({
      customerAmt: 0n,
      driverAmt: escrow,
    });
    expect(splitEscrow(escrow, 10_000)).toEqual({
      customerAmt: escrow,
      driverAmt: 0n,
    });
  });

  it("refuse a share the contract would reject", () => {
    expect(() => splitEscrow(escrow, 10_001)).toThrow();
    expect(() => splitEscrow(escrow, -1)).toThrow();
    expect(() => splitEscrow(escrow, 12.5)).toThrow();
  });

  it("notice a slash bigger than the stake, which the contract silently clamps", () => {
    expect(slashExceedsStake(5n, 4n)).toBe(true);
    expect(slashExceedsStake(4n, 4n)).toBe(false);
  });
});

describe("live signalling", () => {
  // A non-trickle offer of the shape the app's WebView produces — 684 B of SDP
  // measured on a phone (polkadot-host-capabilities web.limits.webrtcLoopback).
  const SDP = [
    "v=0",
    "o=- 8365371654873 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "a=extmap-allow-mixed",
    "a=msid-semantic: WMS",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    "a=candidate:1829696681 1 udp 2122260223 192.168.1.42 49923 typ host generation 0",
    "a=candidate:1829696681 2 udp 2122260223 192.168.1.42 49924 typ host generation 0",
    "a=candidate:842163049 1 udp 1686052607 90.155.12.7 49923 typ srflx raddr 192.168.1.42 rport 49923",
    "a=ice-ufrag:4ZcD",
    "a=ice-pwd:by/2VVi9vUNLuNNRPFXYzOLZ",
    "a=ice-options:trickle",
    "a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89",
    "a=setup:actpass",
    "a=mid:0",
    "a=sctp-port:5000",
    "a=max-message-size:262144",
    "",
  ].join("\r\n");

  it("cut an offer down to what a statement can carry", () => {
    const signal = readSdp(SDP)!;
    expect(signal.ufrag).toBe("4ZcD");
    expect(signal.fingerprint.length).toBe(32);
    // The second component is dropped: a data channel carries no RTCP.
    expect(signal.candidates.length).toBe(2);
    expect(signal.candidates[0]).toEqual({
      protocol: "udp",
      priority: 2122260223,
      address: "192.168.1.42",
      port: 49923,
      type: "host",
    });
    const bytes = encodeSignal(signal);
    // 684 B of SDP, 387 as trimmed text, and this as binary — the point of the
    // exercise being that a statement holds 512 and sealing costs 63 of them.
    expect(bytes.length).toBeLessThan(150);
    expect(bytes.length + 63).toBeLessThan(512);
  });

  it("round-trip a signal, IPv6 and mDNS names included", () => {
    const signal = readSdp(SDP)!;
    expect(decodeSignal(encodeSignal(signal))).toEqual(signal);

    const odd = {
      ...signal,
      candidates: [
        {
          protocol: "tcp" as const,
          priority: 1,
          address: "fe80::1c2b:3d4e",
          port: 9,
          type: "relay",
        },
        {
          protocol: "udp" as const,
          priority: 2,
          address: "e1b2c3d4-0000.local",
          port: 5000,
          type: "host",
        },
      ],
    };
    expect(decodeSignal(encodeSignal(odd))).toEqual(odd);
  });

  it("rebuild an SDP the other side can use", () => {
    const signal = readSdp(SDP)!;
    const rebuilt = writeSdp(signal, "offer");
    // What matters is that the parts that differ survived, and that reading the
    // rebuilt SDP gives back the same signal.
    expect(readSdp(rebuilt)).toEqual(signal);
    expect(rebuilt).toContain("a=ice-ufrag:4ZcD");
    expect(rebuilt).toContain("webrtc-datachannel");
    expect(writeSdp(signal, "answer")).toContain("a=setup:active");
  });

  it("refuse a signal that isn't one", () => {
    expect(readSdp("v=0\r\n")).toBe(null);
    expect(decodeSignal(new Uint8Array([1, 2, 3]))).toBe(null);
    // Trailing rubbish means it isn't ours, not that it's a short signal.
    const bytes = encodeSignal(readSdp(SDP)!);
    expect(decodeSignal(Uint8Array.from([...bytes, 0]))).toBe(null);
  });
});

describe("coarse areas", () => {
  const drop = { lat: 37_784_900, lon: -122_419_400 }; // San Francisco

  it("put everything in a cell in the same cell, whichever corner you start from", () => {
    const cell = cellOf(drop);
    // A metre away is the same square; that is the whole point.
    expect(cellOf({ lat: drop.lat + 100, lon: drop.lon + 100 })).toEqual(cell);
    expect(cellOf({ lat: drop.lat - 100, lon: drop.lon - 100 })).toEqual(cell);
    // The centre of a cell is in its own cell.
    expect(cellOf(cell)).toEqual(cell);
  });

  it("never move a home around, so repeated orders can't be averaged down", () => {
    // The danger with a fuzzed position is that many samples converge on the
    // truth. A grid gives the identical answer every time instead.
    const answers = new Set(
      Array.from({ length: 50 }, () => JSON.stringify(cellOf(drop)))
    );
    expect(answers.size).toBe(1);
  });

  it("keep a cell about a kilometre across, even far from the equator", () => {
    // 0.01° of longitude is much narrower at 60° than at the equator, so the
    // grid widens to compensate rather than quietly revealing more.
    expect(cellWidth(0)).toBe(CELL);
    expect(cellWidth(60_000_000)).toBeGreaterThan(CELL * 1.9);
    for (const lat of [0, 37_000_000, 60_000_000, 75_000_000]) {
      const off = cellVagueness(lat);
      expect(off).toBeGreaterThan(600);
      expect(off).toBeLessThan(900);
    }
  });

  it("carry an area in a statement, and refuse anything else", () => {
    const bytes = encodeArea(42n, cellOf(drop));
    expect(bytes.length).toBe(18);
    const back = decodeArea(bytes)!;
    expect(back.orderId).toBe(42n);
    expect(back.cell).toEqual(cellOf(drop));
    // Southern and western positions are negative, and must survive.
    const sydney = cellOf({ lat: -33_868_800, lon: 151_209_300 });
    expect(decodeArea(encodeArea(7n, sydney))!.cell).toEqual(sydney);
    expect(decodeArea(bytes.slice(0, 17))).toBe(null);
    expect(decodeArea(new Uint8Array(18))).toBe(null);
  });

  it("tell a driver roughly how far a job goes, without telling it where", () => {
    const cell = cellOf(drop);
    const venue = { lat: 37_774_900, lon: -122_419_400 };
    const roughly = metresBetween(venue, cell);
    const truth = metresBetween(venue, drop);
    // Useful for deciding whether to bid, and wrong by less than the cell.
    expect(Math.abs(roughly - truth)).toBeLessThan(cellVagueness(cell.lat));
  });
});

describe("long threads", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    at: 1_758_300_000_000 + i * 1000,
    text: `message ${i} `.repeat(3),
  }));
  const key = `0x${"ab".repeat(32)}`;

  it("carry a pointer to the whole transcript, and still fit", () => {
    const bytes = encodeThread(1n, many, key);
    expect(bytes.length).toBeLessThanOrEqual(448);
    const back = decodeThread(bytes)!;
    expect(back.archive).toBe(key);
    expect(back.said.at(-1)!.text).toBe(many.at(-1)!.text);
    // The pointer costs 32 bytes, so one fewer message rides along.
    expect(back.said.length).toBeLessThan(
      decodeThread(encodeThread(1n, many))!.said.length
    );
  });

  it("say nothing about an archive when there isn't one", () => {
    expect(decodeThread(encodeThread(1n, many))!.archive).toBe(undefined);
    expect(() => encodeThread(1n, many, "0xdead")).toThrow();
  });

  it("know when the window is about to lose something", () => {
    expect(dropsFrom(1n, many.slice(0, 2))).toBe(0);
    expect(dropsFrom(1n, many)).toBeGreaterThan(0);
    // The pointer takes room, so it drops at least as much as without one.
    expect(dropsFrom(1n, many, key)).toBeGreaterThanOrEqual(
      dropsFrom(1n, many)
    );
  });

  it("hold the whole conversation in an archive, window or no window", () => {
    const whole = decodeThread(encodeArchive(1n, many))!;
    expect(whole.said.length).toBe(many.length);
    expect(whole.said[0].text).toBe(many[0].text);
    expect(whole.orderId).toBe(1n);
  });
});
