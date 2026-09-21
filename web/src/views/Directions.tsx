// "Take me there" (docs/IMPROVEMENTS.md §4).
//
// One tap tries the phone's own map app. If that is refused — and it may be,
// since nothing has yet measured what the host does with a `geo:` URI — the
// other two ways appear, with what each one costs written next to it. They are
// not tried automatically: opening a web map REPLACES this app, which would
// throw away an order someone is in the middle of.

import { useState } from "react";
import {
  asText,
  copyPosition,
  openInMapApp,
  webMapUrl,
} from "../order/directions";
import type { Position } from "../order/geo";
import { MAP_FALLBACK } from "../copy/privacy";

export function Directions({
  at,
  label,
  what,
}: {
  at: Position;
  label?: string;
  what: string;
}) {
  const [tried, setTried] = useState<"no" | "asking" | "refused">("no");
  const [copied, setCopied] = useState(false);

  async function go() {
    setTried("asking");
    const outcome = await openInMapApp(at, label);
    setTried(outcome === "opened" ? "no" : "refused");
  }

  return (
    <span className="directions">
      <button className="link" disabled={tried === "asking"} onClick={go}>
        {tried === "asking" ? "opening…" : `directions to ${what}`}
      </button>

      {tried === "refused" && (
        <>
          {" · "}
          <button
            className="link"
            onClick={() =>
              copyPosition(at).then((ok) => {
                setCopied(ok);
                if (!ok) window.prompt("Copy these coordinates", asText(at));
              })
            }
          >
            {copied ? "copied" : "copy the coordinates"}
          </button>
          {" · "}
          <a href={webMapUrl(at)} target="_blank" rel="noreferrer noopener">
            open a web map
          </a>
          <br />
          <span className="muted">{MAP_FALLBACK}</span>
        </>
      )}
    </span>
  );
}
