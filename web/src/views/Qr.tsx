// Showing and scanning handoff codes (order/handoff.ts), ported from FARE.
//
// The code is the same base64 text either way, so a scan and a paste are
// interchangeable — useful when a camera is refused or the light is bad.

import { useEffect, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import jsQR from "jsqr";
import { decodePayload, type Kind } from "../order/handoff";

/** A high-contrast code. Always dark on white: a themed QR doesn't scan. */
export function QrShow({ value, caption }: { value: string; caption?: string }) {
  const qr = qrcode(0, "L");
  qr.addData(value);
  qr.make();
  return (
    <div className="qr">
      <img src={qr.createDataURL(5, 8)} alt="handoff code" />
      {caption && <p className="muted">{caption}</p>}
      <details>
        <summary className="muted">or copy the code</summary>
        <textarea readOnly rows={3} value={value} onFocus={(e) => e.currentTarget.select()} />
      </details>
    </div>
  );
}

/**
 * Read a code with the rear camera. Chromium has a native detector (157–181 ms
 * in the Polkadot app); everything else falls back to jsQR over a canvas.
 * Anything that isn't a Porterage code of `expect` is ignored, so the scanner
 * stays open until the real one is in frame.
 */
export function QrScan({
  expect,
  onRead,
  onCancel,
}: {
  expect: Kind;
  onRead: (text: string) => void;
  onCancel: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");

  useEffect(() => {
    let stream: MediaStream | null = null;
    let frame = 0;
    let done = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const Native = (globalThis as { BarcodeDetector?: new (o: unknown) => { detect(v: unknown): Promise<{ rawValue: string }[]> } })
      .BarcodeDetector;
    const detector = Native ? new Native({ formats: ["qr_code"] }) : null;

    const accept = (text: string): boolean => {
      try {
        if (decodePayload(text).kind !== expect) return false;
      } catch {
        return false;
      }
      done = true;
      onRead(text.trim());
      return true;
    };

    const tick = async () => {
      const el = video.current;
      if (done || !el || el.readyState !== el.HAVE_ENOUGH_DATA) {
        if (!done) frame = requestAnimationFrame(tick);
        return;
      }
      try {
        if (detector) {
          for (const code of await detector.detect(el)) if (accept(code.rawValue)) return;
        } else if (ctx) {
          canvas.width = el.videoWidth;
          canvas.height = el.videoHeight;
          ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
          if (code && accept(code.data)) return;
        }
      } catch {
        /* a bad frame: try the next one */
      }
      if (!done) frame = requestAnimationFrame(tick);
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        const el = video.current;
        if (!el) return;
        el.srcObject = stream;
        await el.play();
        frame = requestAnimationFrame(tick);
      } catch (e) {
        setError(
          (e as { name?: string }).name === "NotAllowedError"
            ? "The camera was refused. Paste the code instead."
            : `No camera: ${(e as Error).message}`,
        );
      }
    })();

    return () => {
      done = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [expect, onRead]);

  return (
    <div className="qr-scan">
      <video ref={video} playsInline muted />
      {error && <p className="warn">{error}</p>}
      <textarea
        rows={2}
        placeholder="or paste the code"
        value={pasted}
        onChange={(e) => setPasted(e.target.value)}
      />
      <div className="actions">
        <button
          disabled={!pasted.trim()}
          onClick={() => {
            try {
              if (decodePayload(pasted).kind !== expect) throw new Error("wrong code");
              onRead(pasted.trim());
            } catch {
              setError("That isn't the code this step expects.");
            }
          }}
        >
          Use the pasted code
        </button>
        <button className="link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
