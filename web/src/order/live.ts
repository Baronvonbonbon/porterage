// A direct connection between two parties, when there can be one (§6.1).
//
// The thread in chat.ts always works: two statements, replaced in place, and
// neither side has to be online at the same time. What it is not is immediate —
// a statement takes a few seconds to come round. So when both sides ARE online
// this opens a WebRTC data channel beside it and sends over that instead, while
// still publishing the statement window so an offline peer catches up.
//
// The signalling goes over the same pair thread, sealed the same way, and that
// is the whole reason this fits: a statement holds 512 bytes, and a non-trickle
// offer's SDP is about 684 (measured in the app, polkadot-host-capabilities
// web.limits.webrtcLoopback). Cutting it to what matters — ice-ufrag, ice-pwd,
// the fingerprint and the candidates — gives 387 bytes of text, and writing
// those as binary gives about 100: a fingerprint is 32 bytes, not 95 characters
// of hex, and an IPv4 candidate is 11, not 60. Everything else in an SDP is the
// same on both sides, because both sides are this same app, so the peer rebuilds
// it from a template.
//
// WITHOUT A STUN OR TURN SERVER this only connects peers that can reach each
// other directly — the same network, usually. That is a real limit and the
// reason the statement thread stays the transport of record rather than a
// fallback nobody maintains. A relay would fix it (docs/PLAN.md Phase 8), and
// needing one is exactly why it is optional.

import {
  SigningKey,
  concat,
  getBytes,
  hexlify,
  keccak256,
  toUtf8Bytes,
  toUtf8String,
} from "ethers";
import { publishStatement, subscribeTopics } from "../market/statements";
import { open, seal, type Reader } from "./seal";
import { sideChannel, threadTopic } from "./chat";

const OFFER = 9;
const ANSWER = 10;

/** How long to wait for ICE gathering before sending what we have. */
const GATHER_MS = 4000;
/** A connection attempt that hasn't opened by now isn't going to. */
const OPEN_MS = 20_000;

// ── the compact offer ────────────────────────────────────────────────────────

export interface Signal {
  ufrag: string;
  pwd: string;
  /** SHA-256 fingerprint, 32 bytes. */
  fingerprint: Uint8Array;
  candidates: Candidate[];
}

export interface Candidate {
  /** 1 udp, 2 tcp. */
  protocol: "udp" | "tcp";
  priority: number;
  address: string;
  port: number;
  /** host, srflx, prflx or relay. */
  type: string;
}

const TYPES = ["host", "srflx", "prflx", "relay"];

const u32 = (v: number) => [
  (v >>> 24) & 255,
  (v >>> 16) & 255,
  (v >>> 8) & 255,
  v & 255,
];

/** An IPv4 address as 4 bytes, or null when it isn't one (IPv6 and mDNS names go as text). */
function ipv4(address: string): Uint8Array | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => Number(p));
  if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null;
  return Uint8Array.from(bytes);
}

/** The signal as bytes: what a peer running this same app needs, and nothing else. */
export function encodeSignal(s: Signal): Uint8Array {
  const out: number[] = [];
  const text = (v: string) => {
    const b = toUtf8Bytes(v);
    if (b.length > 255) throw new Error("that doesn't belong in a signal");
    out.push(b.length, ...b);
  };
  text(s.ufrag);
  text(s.pwd);
  if (s.fingerprint.length !== 32)
    throw new Error("expected a SHA-256 fingerprint");
  out.push(...s.fingerprint);
  out.push(s.candidates.length);
  for (const c of s.candidates) {
    const type = TYPES.indexOf(c.type);
    if (type < 0) throw new Error(`unknown candidate type ${c.type}`);
    const four = ipv4(c.address);
    out.push(type | (c.protocol === "tcp" ? 0x10 : 0) | (four ? 0x20 : 0));
    out.push(...u32(c.priority >>> 0));
    out.push((c.port >> 8) & 255, c.port & 255);
    if (four) out.push(...four);
    else text(c.address);
  }
  return Uint8Array.from(out);
}

export function decodeSignal(bytes: Uint8Array): Signal | null {
  try {
    let at = 0;
    const text = () => {
      const n = bytes[at++];
      const v = toUtf8String(bytes.slice(at, at + n));
      at += n;
      return v;
    };
    const ufrag = text();
    const pwd = text();
    const fingerprint = bytes.slice(at, at + 32);
    at += 32;
    if (fingerprint.length !== 32) return null;
    const count = bytes[at++];
    const candidates: Candidate[] = [];
    for (let i = 0; i < count; i++) {
      const flags = bytes[at++];
      const priority =
        (bytes[at] * 2 ** 24 +
          bytes[at + 1] * 2 ** 16 +
          bytes[at + 2] * 256 +
          bytes[at + 3]) >>>
        0;
      at += 4;
      const port = bytes[at] * 256 + bytes[at + 1];
      at += 2;
      let address: string;
      if (flags & 0x20) {
        address = [...bytes.slice(at, at + 4)].join(".");
        at += 4;
      } else {
        address = text();
      }
      candidates.push({
        protocol: flags & 0x10 ? "tcp" : "udp",
        priority,
        address,
        port,
        type: TYPES[flags & 0x0f],
      });
    }
    if (at !== bytes.length) return null;
    return { ufrag, pwd, fingerprint, candidates };
  } catch {
    return null;
  }
}

/** Pull out of an SDP the parts that differ between two runs of this app. */
export function readSdp(sdp: string): Signal | null {
  const line = (re: RegExp) => sdp.split(/\r?\n/).find((l) => re.test(l));
  const ufrag = line(/^a=ice-ufrag:/)
    ?.slice("a=ice-ufrag:".length)
    .trim();
  const pwd = line(/^a=ice-pwd:/)
    ?.slice("a=ice-pwd:".length)
    .trim();
  const print = line(/^a=fingerprint:sha-256 /i);
  if (!ufrag || !pwd || !print) return null;
  const hex = print.split(" ")[1].replace(/:/g, "");
  if (hex.length !== 64) return null;

  const candidates: Candidate[] = [];
  for (const l of sdp.split(/\r?\n/)) {
    const m =
      /^a=candidate:(\S+) (\d+) (UDP|TCP) (\d+) (\S+) (\d+) typ (\w+)/i.exec(l);
    // Only the first component matters: a data channel carries no RTCP.
    if (!m || m[2] !== "1") continue;
    candidates.push({
      protocol: m[3].toLowerCase() === "tcp" ? "tcp" : "udp",
      priority: Number(m[4]),
      address: m[5],
      port: Number(m[6]),
      type: TYPES.includes(m[7]) ? m[7] : "host",
    });
  }
  return { ufrag, pwd, fingerprint: getBytes(`0x${hex}`), candidates };
}

/**
 * Rebuild an SDP from a signal. Everything not in the signal is fixed, because
 * the peer is this same app in the same WebView — which is what makes a 512-byte
 * statement enough to carry a connection.
 */
export function writeSdp(s: Signal, role: "offer" | "answer"): string {
  const print = [...s.fingerprint]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(":")
    .toUpperCase();
  const lines = [
    "v=0",
    "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "a=extmap-allow-mixed",
    "a=msid-semantic: WMS",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    ...s.candidates.map(
      (c, i) =>
        `a=candidate:${i + 1} 1 ${c.protocol} ${c.priority} ${c.address} ${
          c.port
        } typ ${c.type} generation 0`
    ),
    "a=ice-options:trickle",
    `a=ice-ufrag:${s.ufrag}`,
    `a=ice-pwd:${s.pwd}`,
    `a=fingerprint:sha-256 ${print}`,
    // The offerer takes the active role, so the answerer must be passive.
    `a=setup:${role === "offer" ? "actpass" : "active"}`,
    "a=mid:0",
    "a=sctp-port:5000",
    "a=max-message-size:262144",
    "",
  ];
  return lines.join("\r\n");
}

// ── the connection ───────────────────────────────────────────────────────────

export interface Live {
  send: (text: string) => boolean;
  close: () => void;
}

const channelFor = (topic: string, mine: SigningKey, kind: number): string =>
  keccak256(
    concat([
      toUtf8Bytes(`porterage:live:${kind}`),
      getBytes(sideChannel(topic, mine)),
    ])
  );

/** Wait for ICE to finish, or for the time we're willing to give it. */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => pc.iceGatheringState === "complete" && done();
    const timer = setTimeout(done, GATHER_MS);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

export const liveSupported = (): boolean =>
  typeof RTCPeerConnection !== "undefined";

/**
 * Which side offers. Both run the same code, so without a rule both would offer
 * and neither would answer: the smaller public key calls, and since each side
 * holds both keys they agree without exchanging anything.
 */
export function initiates(mine: SigningKey, theirs: string): boolean {
  const ours = SigningKey.computePublicKey(mine.publicKey, true).toLowerCase();
  return ours < SigningKey.computePublicKey(theirs, true).toLowerCase();
}

/**
 * Try for a direct channel with the other party. Resolves null when there isn't
 * one to be had, which is the common case across two mobile networks — the
 * caller carries on with statements and nothing is lost but the immediacy.
 */
export async function connectLive(
  mine: Reader,
  theirs: string,
  orderId: bigint,
  heard: (text: string) => void,
  opts: { initiate?: boolean } = {}
): Promise<Live | null> {
  if (!liveSupported()) return null;
  const initiate = opts.initiate ?? initiates(mine.signingKey, theirs);
  const topic = threadTopic(mine.signingKey, theirs);
  const pc = new RTCPeerConnection({ iceServers: [] });
  let stopSub: (() => void) | null = null;
  const shut = () => {
    stopSub?.();
    pc.close();
  };

  const wire = (channel: RTCDataChannel) => {
    channel.onmessage = (e) => typeof e.data === "string" && heard(e.data);
  };

  let channel: RTCDataChannel | null = null;
  if (initiate) {
    channel = pc.createDataChannel("porterage", { ordered: true });
    wire(channel);
  } else {
    pc.ondatachannel = (e) => {
      channel = e.channel;
      wire(channel);
    };
  }

  const opened = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), OPEN_MS);
    const check = () => {
      if (channel?.readyState === "open") {
        clearTimeout(timer);
        resolve(true);
      }
    };
    pc.addEventListener(
      "datachannel",
      (e) => ((e as RTCDataChannelEvent).channel.onopen = check)
    );
    const poll = setInterval(check, 250);
    setTimeout(() => clearInterval(poll), OPEN_MS);
  });

  try {
    stopSub = await subscribeTopics([topic], async (bytes) => {
      const offered = await open(mine, OFFER, bytes);
      const answered = await open(mine, ANSWER, bytes);
      const payload = offered ?? answered;
      if (!payload) return;
      const signal = decodeSignal(payload.slice(8));
      if (!signal) return;

      if (offered && !initiate) {
        await pc.setRemoteDescription({
          type: "offer",
          sdp: writeSdp(signal, "offer"),
        });
        await pc.setLocalDescription(await pc.createAnswer());
        await gathered(pc);
        await sendSignal(
          mine,
          theirs,
          topic,
          orderId,
          pc.localDescription!.sdp,
          ANSWER
        );
      } else if (answered && initiate && !pc.currentRemoteDescription) {
        await pc.setRemoteDescription({
          type: "answer",
          sdp: writeSdp(signal, "answer"),
        });
      }
    });

    if (initiate) {
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      await sendSignal(
        mine,
        theirs,
        topic,
        orderId,
        pc.localDescription!.sdp,
        OFFER
      );
    }

    if (!(await opened)) {
      shut();
      return null;
    }
    return {
      send: (text: string) => {
        if (channel?.readyState !== "open") return false;
        channel.send(text);
        return true;
      },
      close: shut,
    };
  } catch {
    shut();
    return null;
  }
}

async function sendSignal(
  mine: Reader,
  theirs: string,
  topic: string,
  orderId: bigint,
  sdp: string,
  kind: number
): Promise<void> {
  const signal = readSdp(sdp);
  if (!signal) throw new Error("this SDP has no signal in it");
  const id = new Uint8Array(8);
  let v = orderId;
  for (let i = 7; i >= 0; i--) {
    id[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  const body = getBytes(concat([id, encodeSignal(signal)]));
  const sealed = await seal(theirs, kind, body);
  if (sealed.length > 512)
    throw new Error(
      `the signal is ${sealed.length} B and a statement holds 512`
    );
  // A short life: an offer is only good while the other side is still there.
  await publishStatement(
    topic,
    channelFor(topic, mine.signingKey, kind),
    sealed,
    300
  );
}

export const signalBytes = (sdp: string): number => {
  const s = readSdp(sdp);
  return s ? encodeSignal(s).length : -1;
};

export const _hexFingerprint = (f: Uint8Array): string => hexlify(f);
