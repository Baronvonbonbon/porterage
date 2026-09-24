// The QR code screens, fetched when one is actually needed.
//
// `jsqr` and `qrcode-generator` are 317 kB between them, and a role screen
// imported them the moment it opened — a driver waiting on the pavement paid
// for the scanner before knowing whether this job would need one. The handover
// is one step of one order, and the camera is a screen somebody deliberately
// opens.
//
// Drop-in replacements: same names, same props, so call sites read as they did
// and nobody has to remember which import is the lazy one. The Suspense
// boundary lives here rather than at each call site for the same reason.

import { lazy, Suspense, type ComponentProps } from "react";
import type { QrScan as QrScanType, QrShow as QrShowType } from "./Qr";

const Scan = lazy(() => import("./Qr").then((m) => ({ default: m.QrScan })));
const Show = lazy(() => import("./Qr").then((m) => ({ default: m.QrShow })));

const waiting = <p className="muted">Opening the camera…</p>;

export function QrScan(props: ComponentProps<typeof QrScanType>) {
  return (
    <Suspense fallback={waiting}>
      <Scan {...props} />
    </Suspense>
  );
}

export function QrShow(props: ComponentProps<typeof QrShowType>) {
  return (
    <Suspense fallback={<p className="muted">Drawing the code…</p>}>
      <Show {...props} />
    </Suspense>
  );
}
