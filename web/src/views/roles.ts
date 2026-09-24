// The five role screens, each fetched only when somebody asks for it.
//
// Everything lived in one chunk: 1.76 MB, every byte of it downloaded over
// IPFS before the role chooser — five buttons and a paragraph — could appear.
// Most of that weight belongs to exactly one role. Poseidon (609 kB) is the
// commitment and note-tree maths, which the customer needs and nobody else
// does. jsQR and the QR generator (317 kB together) are the handover, which
// only a driver and a counter ever reach. The operations console and the phone
// probes are not roles at all and are opened perhaps once.
//
// Splitting here rather than deeper is deliberate. A role boundary is a real
// boundary — you are one thing at a time — and it needs no change to the money
// paths, where `pool.ts` and `payout.ts` use Poseidon synchronously inside
// tree walks that would have to become async to load it on demand. Rewriting
// those to chase a download is the kind of change that loses somebody's note.
//
// `preload` exists so the splash can start a role's download as one of its own
// steps: a returning device knows its role before React mounts, so there is no
// reason to wait for the app to render before asking for it.

import { lazy } from "react";
import type { Role } from "../role";

const loaders = {
  customer: () => import("./customer/Customer"),
  driver: () => import("./Driver"),
  venue: () => import("./Venue"),
  ops: () => import("./Ops"),
  probe: () => import("./Probe"),
} as const;

/** Start fetching a role's code. Safe to call more than once. */
export const preload = (role: Role): Promise<unknown> => loaders[role]();

/** Each screen exports a named component; React.lazy wants a default. */
export const Screen = {
  customer: lazy(() =>
    loaders.customer().then((m) => ({ default: m.Customer }))
  ),
  driver: lazy(() => loaders.driver().then((m) => ({ default: m.Driver }))),
  venue: lazy(() => loaders.venue().then((m) => ({ default: m.Venue }))),
  ops: lazy(() => loaders.ops().then((m) => ({ default: m.Ops }))),
  probe: lazy(() => loaders.probe().then((m) => ({ default: m.Probe }))),
} as const;
