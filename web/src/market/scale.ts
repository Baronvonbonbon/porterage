// Just enough SCALE to read a Statement Store statement off a node's RPC, for
// the relay (tools/relay.ts). Inside the app the host decodes statements itself.
//
// A statement is a Vec<Field>; each field is a tag byte and its payload:
//   0 proof (sr25519, ed25519, ecdsa or on-chain)  1 decryption key  2 expiry (u64)
//   3 channel  4–7 topics 1–4  8 data (Vec<u8>)

export interface RawStatement {
  topics: Uint8Array[];
  channel?: Uint8Array;
  expiry?: bigint;
  data?: Uint8Array;
}

function compact(b: Uint8Array, at: number): [number, number] {
  const mode = b[at] & 3;
  if (mode === 0) return [b[at] >> 2, 1];
  if (mode === 1) return [(b[at] | (b[at + 1] << 8)) >> 2, 2];
  if (mode === 2) return [(b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 2, 4];
  throw new Error("statement too large");
}

const PROOF_BYTES = [96, 96, 98, 72];

export function decodeStatement(b: Uint8Array): RawStatement {
  const out: RawStatement = { topics: [] };
  let [n, at] = compact(b, 0);
  while (n--) {
    const tag = b[at++];
    if (tag === 0) {
      const kind = b[at++];
      if (kind >= PROOF_BYTES.length) throw new Error(`unknown proof kind ${kind}`);
      at += PROOF_BYTES[kind];
    } else if (tag === 1) at += 32;
    else if (tag === 2) {
      let v = 0n;
      for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[at + i]);
      out.expiry = v;
      at += 8;
    } else if (tag === 3) {
      out.channel = b.slice(at, at + 32);
      at += 32;
    } else if (tag >= 4 && tag <= 7) {
      out.topics.push(b.slice(at, at + 32));
      at += 32;
    } else if (tag === 8) {
      const [len, w] = compact(b, at);
      at += w;
      out.data = b.slice(at, at + len);
      at += len;
    } else throw new Error(`unknown statement field ${tag}`);
  }
  return out;
}
