// Taking the delivery photo (order/evidence.ts).
//
// Shrunk hard before it goes anywhere: Bulletin writes are slow (64 bytes took
// 6.7–29.8 s in the probes), and the evidence only has to show the doorstep, not
// print it. 640 pixels wide at middling quality is a few tens of kilobytes.

import { useEffect, useRef, useState } from "react";

const MAX_WIDTH = 640;
const QUALITY = 0.5;

export function Camera({
  onTaken,
  onCancel,
}: {
  onTaken: (jpeg: Uint8Array) => void;
  onCancel: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        const el = video.current;
        if (!el) return;
        el.srcObject = stream;
        await el.play();
      } catch (e) {
        setError(
          (e as { name?: string }).name === "NotAllowedError"
            ? "The camera was refused, so there's no photo for this delivery."
            : `No camera: ${(e as Error).message}`
        );
      }
    })();
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);

  function take() {
    const el = video.current;
    if (!el) return;
    const scale = Math.min(1, MAX_WIDTH / (el.videoWidth || MAX_WIDTH));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round((el.videoWidth || MAX_WIDTH) * scale);
    canvas.height = Math.round((el.videoHeight || MAX_WIDTH) * scale);
    canvas.getContext("2d")?.drawImage(el, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/jpeg", QUALITY);
    onTaken(Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0)));
  }

  return (
    <div className="qr-scan">
      <video ref={video} playsInline muted />
      {error && <p className="warn">{error}</p>}
      <div className="actions">
        <button disabled={!!error} onClick={take}>
          Take the photo
        </button>
        <button className="link" onClick={onCancel}>
          Skip it
        </button>
      </div>
    </div>
  );
}
