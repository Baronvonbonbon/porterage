// Sealed envelopes between two parties who only know each other's public key
// (docs/PLAN.md §6.2). Used for bids and for baskets.
//
// Statements are public gossip, so anything in one that isn't meant for
// everybody is sealed here first: a throwaway key for each envelope, ECDH to the
// recipient, AES-GCM over the payload. A fresh key per envelope means two
// envelopes from the same sender don't look related to anyone watching.
//
//   0      version
//   1      kind
//   2..35  the sender's throwaway public key
//   35..47 nonce
//   47..   the sealed payload

import {
  SigningKey,
  Wallet,
  concat,
  getBytes,
  hexlify,
  keccak256,
} from "ethers";

export const VERSION = 1;
const HEADER = 47;

export type Reader = { signingKey: SigningKey };

async function sharedKey(mine: SigningKey, theirs: string): Promise<CryptoKey> {
  // The shared point's x coordinate, hashed: the standard ECDH-to-AES step.
  const shared = getBytes(mine.computeSharedSecret(theirs));
  const material = getBytes(keccak256(shared.slice(1, 33)));
  return crypto.subtle.importKey(
    "raw",
    material as BufferSource,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"]
  );
}

export async function seal(
  theirs: string,
  kind: number,
  payload: Uint8Array
): Promise<Uint8Array> {
  const ephemeral = Wallet.createRandom();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await sharedKey(ephemeral.signingKey, theirs),
      payload as BufferSource
    )
  );
  const pub = getBytes(
    SigningKey.computePublicKey(ephemeral.signingKey.publicKey, true)
  );
  return getBytes(concat([new Uint8Array([VERSION, kind]), pub, iv, body]));
}

/** Open an envelope addressed to `mine`. Null when it isn't one, or isn't ours. */
export async function open(
  mine: Reader,
  kind: number,
  bytes: Uint8Array
): Promise<Uint8Array | null> {
  if (bytes.length <= HEADER || bytes[0] !== VERSION || bytes[1] !== kind)
    return null;
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(35, 47) as BufferSource },
        await sharedKey(mine.signingKey, hexlify(bytes.slice(2, 35))),
        bytes.slice(HEADER) as BufferSource
      )
    );
  } catch {
    return null; // someone else's envelope, or noise on the topic
  }
}
