// "Check this phone" — running the four measurements in probe.ts.
//
// The screen is a list of questions rather than a wizard on purpose: they are
// independent, they can be run in any order, and a phone that fails the first
// one should not be stopped from answering the other three. Each row shows
// what the question decides, because a probe whose answer changes nothing is
// not worth someone's time, and saying so is the only way to prove it isn't.
//
// The rule the screen keeps: what the code saw and what the person saw are
// recorded separately and never merged. A resolved promise is not a map app
// opening, and this screen must not be the place that quietly turns one into
// the other.

import { useEffect, useState } from "react";
import { Wallet } from "ethers";
import {
  answer,
  asReport,
  beginning,
  forget,
  QUESTIONS,
  readBook,
  record,
  type Book,
  type ProbeId,
} from "../probe";
import { openInMapApp } from "../order/directions";
import { hostPut } from "../host";
import { scheduleProbe } from "../notify";
import { encodePickup, nowSeconds, signPickup } from "../order/handoff";
import { QrScan, QrShow } from "./Qr";
import { errorText } from "../format";

/** Somewhere unmistakable, so a map that opens is obviously the probe's. */
const SOMEWHERE = { lat: 51_500_700, lon: -124_500 };

export function Probe() {
  const [book, setBook] = useState<Book>(readBook());
  const [busy, setBusy] = useState<ProbeId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [copied, setCopied] = useState(false);

  const reload = () => setBook(readBook());

  // A probe left pending is the interesting case: the page did not survive it.
  const pending = QUESTIONS.filter((q) => book[q.id]?.pending);

  async function run(id: ProbeId, fn: () => Promise<void>) {
    setBusy(id);
    setError(null);
    try {
      await fn();
    } catch (e) {
      record(id, `threw: ${errorText(e)}`);
      setError(errorText(e));
    } finally {
      reload();
      setBusy(null);
    }
  }

  const probes: Record<ProbeId, () => Promise<void>> = {
    // Marked before the call, not after: if the host navigates the WebView
    // instead of handing the URI to the OS, nothing after this line runs.
    geo: async () => {
      beginning("geo", "navigateTo(geo:…) called, no answer yet");
      const started = Date.now();
      const outcome = await openInMapApp(SOMEWHERE, "Porterage probe");
      record("geo", `navigateTo(geo:) → ${outcome}`, Date.now() - started);
    },

    // Two distinct blobs, so neither can be answered from a cache. The
    // durations are objective; the number of prompts only the person can say.
    bulletin: async () => {
      const stamp = Date.now();
      const one = new TextEncoder().encode(`porterage probe a ${stamp}`);
      const two = new TextEncoder().encode(`porterage probe b ${stamp}`);
      const t0 = Date.now();
      await hostPut(one);
      const first = Date.now() - t0;
      const t1 = Date.now();
      await hostPut(two);
      const second = Date.now() - t1;
      record(
        "bulletin",
        `two writes: ${first} ms then ${second} ms`,
        first + second
      );
    },

    // A real pickup code, signed by a throwaway key, for this phone to scan off
    // its own screen. It exercises the encoder and the scanner together, which
    // is the handoff minus the second phone.
    camera: async () => {
      // A throwaway signer: the code only has to be well-formed, and this
      // one is thrown away before the function returns.
      const key = new Wallet(Wallet.createRandom().privateKey);
      const timestamp = nowSeconds();
      const signature = await signPickup(
        key,
        1n,
        key.address,
        SOMEWHERE,
        timestamp
      );
      setCode(
        encodePickup({ orderId: 1n, at: SOMEWHERE, timestamp, signature })
      );
      record("camera", "code shown, waiting for a scan");
    },

    notification: async () => {
      const ms = await scheduleProbe(30);
      record(
        "notification",
        ms === null
          ? "the host offers no notifications"
          : "scheduled for 30 s from now",
        ms ?? undefined
      );
    },
  };

  useEffect(() => {
    setCopied(false);
  }, [book]);

  return (
    <section>
      <h2>Check this phone</h2>
      <p className="muted">
        Four things nothing but a phone can answer. Each takes a minute, and
        each decides how something gets built. Nothing here touches an order, an
        account or any money.
      </p>

      {pending.length > 0 && (
        <div className="notice">
          <p>
            <b>
              {pending.length === 1
                ? "A probe didn't come back."
                : `${pending.length} probes didn't come back.`}
            </b>{" "}
            The app was reloaded or replaced while it was running, which is
            itself an answer. What happened?
          </p>
          {pending.map((q) => (
            <p key={q.id}>
              {q.asks}
              <br />
              <Answers
                choices={q.choices}
                onPick={(text) => {
                  answer(q.id, text);
                  reload();
                }}
              />
            </p>
          ))}
        </div>
      )}

      {QUESTIONS.map((q) => {
        const r = book[q.id];
        return (
          <div className="probe" key={q.id}>
            <p className="lead">{q.asks}</p>
            <p className="muted">{q.expect}</p>
            <p className="muted">
              <b>Decides:</b> {q.decides}
            </p>

            <div className="actions">
              <button
                className="primary"
                disabled={!!busy}
                onClick={() => run(q.id, probes[q.id])}
              >
                {busy === q.id ? "running…" : r ? "Run it again" : "Run it"}
              </button>
              {r && (
                <button
                  className="link"
                  onClick={() => {
                    forget(q.id);
                    reload();
                  }}
                >
                  clear
                </button>
              )}
            </div>

            {q.id === "camera" && code && (
              <>
                <QrShow
                  value={code}
                  caption="Scan this with the button below."
                />
                {scanning ? (
                  <QrScan
                    expect="pickup"
                    onRead={(_text, how) => {
                      setScanning(false);
                      if (how === "camera") {
                        setCode(null);
                        record(
                          "camera",
                          "the camera read the code off the screen"
                        );
                        answer("camera", "Scanned it");
                      } else {
                        // A paste proves the encoder and the decoder agree and
                        // nothing else. It used to be recorded as a scan, which
                        // is the one mistake this whole module is against.
                        record(
                          "camera",
                          "pasted — the code decoded, the camera was not exercised"
                        );
                      }
                      reload();
                    }}
                    onTrouble={(why) => {
                      record("camera", `camera never started — ${why}`);
                      reload();
                    }}
                    onCancel={() => setScanning(false)}
                  />
                ) : (
                  <button onClick={() => setScanning(true)}>
                    Open the scanner
                  </button>
                )}
              </>
            )}

            {r && (
              <p className={r.pending ? "warn" : "ok"}>
                {r.measured}
                {r.ms !== undefined && ` — ${r.ms} ms`}
                {r.answered && (
                  <>
                    <br />
                    You saw: {r.answered}
                  </>
                )}
              </p>
            )}

            {r && !r.answered && !r.pending && (
              <Answers
                choices={q.choices}
                onPick={(text) => {
                  answer(q.id, text);
                  reload();
                }}
              />
            )}
          </div>
        );
      })}

      {error && <p className="error">{error}</p>}

      <h3>What to send back</h3>
      <p className="muted">
        Paste this into the repo. It holds outcomes and timings only — no keys,
        no addresses, nothing about you.
      </p>
      <pre className="report">{asReport(book)}</pre>
      <button
        className="link"
        onClick={() =>
          navigator.clipboard
            .writeText(asReport(book))
            .then(() => setCopied(true))
            .catch(() => setCopied(false))
        }
      >
        {copied ? "copied" : "copy the report"}
      </button>
    </section>
  );
}

/** What the person saw, which no promise can report. */
function Answers({
  choices,
  onPick,
}: {
  choices: string[];
  onPick: (text: string) => void;
}) {
  return (
    <div className="chooser">
      {choices.map((c) => (
        <button key={c} type="button" onClick={() => onPick(c)}>
          {c}
        </button>
      ))}
    </div>
  );
}
