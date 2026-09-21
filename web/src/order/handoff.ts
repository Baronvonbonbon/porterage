// Handing over, without either phone knowing where it is (docs/PLAN.md §4).
//
// The Polkadot app's WebView refuses geolocation, so neither side can read a
// position. Both handoffs work anyway, because the positions that matter are
// ones the chain already holds or the customer already chose:
//
//   PICKUP    the venue's registered pin is public. The counter signs it, the
//             driver signs the same pin, and the contract's radius check passes
//             by construction. What it proves is that both were there to
//             exchange a QR code, which is the point.
//   DROPOFF   the customer commits to its own drop under a fresh salt and shows
//             that commitment. The driver signs it blind — it never learns a
//             coordinate — and the customer proves proximity with the driver's
//             position set to the drop.
//
// Every payload here is a QR code: small, versioned, and base64url so it also
// pastes as text.

import { AbiCoder, Contract, getBytes, hexlify, type Wallet } from "ethers";
import { ABI, addressOf, ethProvider, read, writable } from "../contracts";
import {
  b32,
  dropNullifier,
  encLat,
  encLon,
  positionCommit,
  randomSalt,
  type Position,
} from "./geo";

export const PHASE_PICKUP = 1;
export const PHASE_DROPOFF = 2;

const VERSION = 1;
export const KIND = { pickup: 1, dropRequest: 2, dropSignature: 3 } as const;
export type Kind = keyof typeof KIND;

const WASM = "./zk/proximity.wasm";
const ZKEY = "./zk/proximity.zkey";

// ── payloads ────────────────────────────────────────────────────────────────

const b64 = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64 = (s: string) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(
    atob(t.padEnd(Math.ceil(t.length / 4) * 4, "=")),
    (c) => c.charCodeAt(0)
  );
};

function put(out: Uint8Array, at: number, v: bigint, bytes: number) {
  for (let i = bytes - 1; i >= 0; i--) {
    out[at + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}
function get(b: Uint8Array, at: number, bytes: number): bigint {
  let v = 0n;
  for (let i = 0; i < bytes; i++) v = (v << 8n) | BigInt(b[at + i]);
  return v;
}
const signed = (v: bigint): number => Number(BigInt.asIntN(32, v));

export interface PickupPayload {
  orderId: bigint;
  at: Position;
  timestamp: bigint;
  /** The venue signer's signature over its own attestation. */
  signature: string;
}

/** The counter's code: the pin it signed, when, and the signature. 91 bytes. */
export function encodePickup(p: PickupPayload): string {
  const out = new Uint8Array(91);
  out[0] = VERSION;
  out[1] = KIND.pickup;
  put(out, 2, p.orderId, 8);
  put(out, 10, BigInt.asUintN(32, BigInt(p.at.lat)), 4);
  put(out, 14, BigInt.asUintN(32, BigInt(p.at.lon)), 4);
  put(out, 18, p.timestamp, 8);
  out.set(getBytes(p.signature), 26);
  return b64(out);
}

export interface DropRequestPayload {
  orderId: bigint;
  /** Poseidon(drop, a fresh salt): what the driver is asked to sign. */
  posCommit: string;
  timestamp: bigint;
}

/** The customer's code at the door. 50 bytes, and it carries no coordinate. */
export function encodeDropRequest(p: DropRequestPayload): string {
  const out = new Uint8Array(50);
  out[0] = VERSION;
  out[1] = KIND.dropRequest;
  put(out, 2, p.orderId, 8);
  out.set(getBytes(p.posCommit), 10);
  put(out, 42, p.timestamp, 8);
  return b64(out);
}

export interface DropSignaturePayload {
  orderId: bigint;
  timestamp: bigint;
  signature: string;
}

/** The driver's code back: its signature over what it was shown. 83 bytes. */
export function encodeDropSignature(p: DropSignaturePayload): string {
  const out = new Uint8Array(83);
  out[0] = VERSION;
  out[1] = KIND.dropSignature;
  put(out, 2, p.orderId, 8);
  put(out, 10, p.timestamp, 8);
  out.set(getBytes(p.signature), 18);
  return b64(out);
}

export type Payload =
  | ({ kind: "pickup" } & PickupPayload)
  | ({ kind: "dropRequest" } & DropRequestPayload)
  | ({ kind: "dropSignature" } & DropSignaturePayload);

/** Read any handoff code. Throws on anything that isn't one, so scanners can keep looking. */
export function decodePayload(text: string): Payload {
  const b = unb64(text.trim());
  if (b.length < 2 || b[0] !== VERSION) throw new Error("not a Porterage code");
  if (b[1] === KIND.pickup && b.length === 91) {
    return {
      kind: "pickup",
      orderId: get(b, 2, 8),
      at: { lat: signed(get(b, 10, 4)), lon: signed(get(b, 14, 4)) },
      timestamp: get(b, 18, 8),
      signature: hexlify(b.slice(26)),
    };
  }
  if (b[1] === KIND.dropRequest && b.length === 50) {
    return {
      kind: "dropRequest",
      orderId: get(b, 2, 8),
      posCommit: hexlify(b.slice(10, 42)),
      timestamp: get(b, 42, 8),
    };
  }
  if (b[1] === KIND.dropSignature && b.length === 83) {
    return {
      kind: "dropSignature",
      orderId: get(b, 2, 8),
      timestamp: get(b, 10, 8),
      signature: hexlify(b.slice(18)),
    };
  }
  throw new Error("not a Porterage code");
}

// ── signing ─────────────────────────────────────────────────────────────────

const LOCATION_TYPES = {
  LocationAttestation: [
    { name: "orderId", type: "uint256" },
    { name: "phase", type: "uint8" },
    { name: "actor", type: "address" },
    { name: "lat", type: "int32" },
    { name: "lon", type: "int32" },
    { name: "timestamp", type: "uint64" },
  ],
};
const DRIVER_COMMIT_TYPES = {
  DriverCommitAttestation: [
    { name: "orderId", type: "uint256" },
    { name: "phase", type: "uint8" },
    { name: "actor", type: "address" },
    { name: "posCommit", type: "bytes32" },
    { name: "timestamp", type: "uint64" },
  ],
};

async function domain() {
  const { chainId } = await ethProvider().getNetwork();
  return {
    name: "PorterSettlement",
    version: "1",
    chainId,
    verifyingContract: addressOf("settlement"),
  };
}

export const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));

/** The counter signs the venue's own registered pin for this order. No taps. */
export async function signPickup(
  key: Wallet,
  orderId: bigint,
  actor: string,
  at: Position,
  timestamp = nowSeconds()
): Promise<string> {
  const att = {
    orderId,
    phase: PHASE_PICKUP,
    actor,
    lat: at.lat,
    lon: at.lon,
    timestamp,
  };
  return key.signTypedData(await domain(), LOCATION_TYPES, att);
}

/** The driver signs the commitment it was shown, without knowing what it opens to. */
export async function signDropCommit(
  key: Wallet,
  orderId: bigint,
  driver: string,
  posCommit: string,
  timestamp = nowSeconds()
): Promise<string> {
  const att = {
    orderId,
    phase: PHASE_DROPOFF,
    actor: driver,
    posCommit,
    timestamp,
  };
  return key.signTypedData(await domain(), DRIVER_COMMIT_TYPES, att);
}

// ── settlement ──────────────────────────────────────────────────────────────

const settlementWith = (signer: Wallet) =>
  new Contract(
    addressOf("settlement"),
    ABI.settlement.fragments as never,
    writable(signer)
  );

/**
 * Confirm the pickup: the driver signs the same pin the counter signed and sends
 * both attestations. Sent by the driver's session key, so no taps — and the
 * venue is paid the moment it lands.
 */
export async function confirmPickup(
  sessionKey: Wallet,
  driver: string,
  code: PickupPayload,
  venueSigner: string
) {
  const timestamp = nowSeconds();
  const driverSig = await signPickup(
    sessionKey,
    code.orderId,
    driver,
    code.at,
    timestamp
  );
  const driverAtt = {
    orderId: code.orderId,
    phase: PHASE_PICKUP,
    actor: driver,
    lat: code.at.lat,
    lon: code.at.lon,
    timestamp,
  };
  const venueAtt = {
    orderId: code.orderId,
    phase: PHASE_PICKUP,
    actor: venueSigner,
    lat: code.at.lat,
    lon: code.at.lon,
    timestamp: code.timestamp,
  };
  const tx = await settlementWith(sessionKey).confirmPickup(
    driverAtt,
    driverSig,
    venueAtt,
    code.signature
  );
  await tx.wait();
}

export interface DropRequest {
  payload: DropRequestPayload;
  /** The salt behind the commitment the driver signs; kept for the proof. */
  driverSalt: bigint;
}

/** Build the code the customer shows at the door: a commitment to its own drop. */
export function makeDropRequest(orderId: bigint, drop: Position): DropRequest {
  const driverSalt = randomSalt();
  return {
    payload: {
      orderId,
      posCommit: b32(positionCommit(drop, driverSalt)),
      timestamp: nowSeconds(),
    },
    driverSalt,
  };
}

/**
 * Prove the delivery and settle it, from the order's own account.
 *
 * The proof opens both commitments privately: the order's drop commitment with
 * the salt kept since the order was placed, and the driver's with the salt from
 * the request just shown. The driver's position is the drop itself, so the
 * distance is zero — what the chain learns is that the driver signed the
 * customer's commitment at the door, and no coordinate ever appears.
 */
export async function confirmDropoff(args: {
  burner: Wallet;
  orderId: bigint;
  driver: string;
  drop: Position;
  /** The salt the order's on-chain commitment was made with. */
  dropSalt: bigint;
  request: DropRequest;
  signature: string;
  signedAt: bigint;
}): Promise<{ proveMs: number }> {
  const radius = Number(await read("settlement").dropoffRadiusMeters());
  const dropCommit = positionCommit(args.drop, args.dropSalt);
  const driverCommit = BigInt(args.request.payload.posCommit);
  const nullifier = dropNullifier(args.dropSalt, args.orderId);

  const snarkjs = await import("snarkjs");
  const started = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    {
      orderId: args.orderId.toString(),
      dropCommit: dropCommit.toString(),
      driverCommit: driverCommit.toString(),
      radiusMeters: String(radius),
      nullifier: nullifier.toString(),
      custLatEnc: encLat(args.drop.lat).toString(),
      custLonEnc: encLon(args.drop.lon).toString(),
      salt: args.dropSalt.toString(),
      drvLatEnc: encLat(args.drop.lat).toString(),
      drvLonEnc: encLon(args.drop.lon).toString(),
      drvSalt: args.request.driverSalt.toString(),
    },
    WASM,
    ZKEY
  );
  const proveMs = Math.round(performance.now() - started);

  const packed = AbiCoder.defaultAbiCoder().encode(Array(8).fill("uint256"), [
    proof.pi_a[0],
    proof.pi_a[1],
    proof.pi_b[0][1],
    proof.pi_b[0][0],
    proof.pi_b[1][1],
    proof.pi_b[1][0],
    proof.pi_c[0],
    proof.pi_c[1],
  ]);
  const driverAtt = {
    orderId: args.orderId,
    phase: PHASE_DROPOFF,
    actor: args.driver,
    posCommit: args.request.payload.posCommit,
    timestamp: args.signedAt,
  };
  const tx = await settlementWith(args.burner).confirmDropoffZK(
    driverAtt,
    args.signature,
    packed,
    publicSignals
  );
  await tx.wait();
  return { proveMs };
}
