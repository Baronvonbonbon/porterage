// The picture on a venue's tile (docs/IMPROVEMENTS.md §5).
//
// Deliberately NOT in `evidence.ts`, and the difference is the whole reason
// this is its own module: a delivery photo is sealed to one reader and exists
// to settle an argument, while a shopfront photo is a advertisement. It is
// public, it is meant to be looked at by strangers, and encrypting it would be
// theatre — the key would have to ship to everyone who can read the menu.
//
// So it is stored plainly on Bulletin and referenced by its key. A key and not
// a URL, because a URL would have every customer browsing the list fetch an
// image from the vendor's own server, and that server would then know who is
// shopping, from where, and when. The menu is already public; making the
// picture public costs nothing extra, but making the FETCH public would.
//
// Size matters more here than for evidence. A list of twenty tiles is twenty
// fetches through a host whose reads are flaky and whose writes were measured
// at 6–31 seconds (probe.ts, 2026-09-21), so the picture is shrunk hard before
// it is ever uploaded: a tile is about 160 logical pixels wide, and anything
// beyond 480 real pixels is bytes nobody sees.

import { hostGet, hostPut } from "../host";

/** Wider than any tile draws, and small enough to arrive. */
const MAX_WIDTH = 480;
const QUALITY = 0.72;

/**
 * Refuse anything that would make browsing slow. A vendor is choosing this
 * once; a hundred customers pay for it every time the list opens.
 */
export const MAX_BYTES = 90_000;

/**
 * Shrink a chosen image to tile size and return JPEG bytes. Takes whatever
 * the file picker gave — a 12-megapixel phone photo, usually — and returns
 * something in the tens of kilobytes.
 */
export async function shrink(file: Blob): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_WIDTH / bitmap.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("this device can't resize an image");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/jpeg", QUALITY);
    return Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0));
  } finally {
    bitmap.close();
  }
}

/** Put a shopfront picture on Bulletin. One host prompt, several seconds. */
export async function publishPhoto(bytes: Uint8Array): Promise<string> {
  if (bytes.length > MAX_BYTES)
    throw new Error(
      `that picture is ${Math.round(bytes.length / 1024)} kB; the limit is ` +
        `${Math.round(MAX_BYTES / 1024)} kB so the venue list stays quick`
    );
  return hostPut(bytes);
}

// ── reading ─────────────────────────────────────────────────────────────────

/**
 * Object URLs, kept for the life of the page and keyed by Bulletin key. The key
 * IS the content hash, so a cached picture can never be the wrong one — the
 * same trick the menu cache uses, and the reason neither needs invalidating.
 *
 * A failed fetch is cached too, as null. Without that, a venue whose photo has
 * aged out of Bulletin would be retried on every render of the list.
 */
const seen = new Map<string, Promise<string | null>>();

export function photoUrl(key: string): Promise<string | null> {
  // A demo venue carries its picture inline (order/menu.ts), so there is
  // nothing to fetch and nothing that can fail to arrive.
  if (key.startsWith("data:")) return Promise.resolve(key);
  const found = seen.get(key);
  if (found) return found;
  const fetching = (async () => {
    try {
      const bytes = await hostGet(key);
      if (!bytes?.length) return null;
      return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    } catch {
      return null;
    }
  })();
  seen.set(key, fetching);
  return fetching;
}

/** For tests and for a vendor replacing its own picture. */
export function _forgetPhotos(): void {
  for (const pending of seen.values())
    pending
      .then((url) => url && URL.revokeObjectURL(url))
      .catch(() => undefined);
  seen.clear();
}
