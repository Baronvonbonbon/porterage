// Helping fund other people's private orders (docs/PLAN.md §5.3): while this is
// on, the driver's session key submits funding requests it hears on the
// Statement Store and is tipped by each burner it funds. No taps: the session
// key signs, and it only pays gas.

import { useEffect, useRef, useState } from "react";
import type { Wallet } from "ethers";
import { SHIELD_POOL } from "../config";
import { addressOf, deployed } from "../contracts";
import { ethProvider } from "../contracts";
import {
  publishClaim,
  subscribeClaims,
  subscribeRequests,
} from "../market/statements";
import {
  submitPayout,
  submitRequest,
  type SubmitOutcome,
} from "../market/submit";
import { Claims } from "../market/auction";
import { errorText, pasWei, short } from "../format";

/** How often a waiting request is re-priced, and how long before giving up. */
const RETRY_MS = 3_000;
const PENDING_MS = 60 * 60_000;

export function Helper({ sessionKey }: { sessionKey: Wallet }) {
  const [on, setOn] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const queue = useRef(Promise.resolve());

  useEffect(() => {
    if (!on) return;
    const signer = sessionKey.connect(ethProvider());
    const note = (line: string) =>
      setLog((l) =>
        [`${new Date().toLocaleTimeString()} ${line}`, ...l].slice(0, 8)
      );
    const stops: Array<() => void> = [];
    const claims = new Claims();

    // A request is worth taking only once the price has climbed to cover this
    // phone's gas, so a "waiting" verdict has to be re-asked rather than
    // dropped. Judging each request once, on arrival, would mean judging every
    // one of them at its floor and never taking any.
    const pending = new Map<string, { at: number; go: () => void }>();

    // One at a time, so the session key's nonces don't collide.
    const run = (
      key: string,
      what: string,
      job: () => Promise<SubmitOutcome>
    ) => {
      queue.current = queue.current.then(async () => {
        if (!pending.has(key)) return;
        try {
          const r = await job();
          if (r.status === "sent") {
            pending.delete(key);
            note(`${what} for ${pasWei(r.fee)} (tx ${short(r.hash)})`);
          } else if (r.status === "skipped") {
            pending.delete(key);
            if (r.reason !== "already handled") note(`skipped ${what}: ${r.reason}`);
          }
          // "waiting": the ticker asks again as the price climbs.
        } catch (e) {
          pending.delete(key);
          note(`failed ${what}: ${errorText(e)}`);
        }
      });
    };

    const watch = (key: string, what: string, job: () => Promise<SubmitOutcome>) => {
      if (pending.has(key)) return;
      const go = () => run(key, what, job);
      pending.set(key, { at: Date.now(), go });
      go();
    };

    const ticker = setInterval(() => {
      for (const [key, held] of [...pending]) {
        if (Date.now() - held.at > PENDING_MS) {
          pending.delete(key);
          continue;
        }
        held.go();
      }
    }, RETRY_MS);

    subscribeRequests({
      fund: (req) =>
        watch(req.proof.pubSignals[1], `funded ${short(req.proof.recipient)}`, () =>
          submitRequest(req, SHIELD_POOL, signer, {
            claims,
            // Unlike the relay, a phone HAS a Statement Store account, so it
            // says "mine" before spending gas. That is what stops two helpers
            // paying for the same withdrawal and one of them losing the lot.
            announce: (k) => publishClaim(k, signer.address),
          })
        ),
      payout: (req) =>
        deployed() &&
        watch(req.nullifierHash, "released a payout", () =>
          submitPayout(req, addressOf("vault"), signer, { claims })
        ),
    })
      .then((s) => stops.push(s))
      .catch((e) => note(errorText(e)));
    subscribeClaims(claims)
      .then((s) => stops.push(s))
      .catch(() => undefined);
    note("listening for funding requests");
    return () => {
      clearInterval(ticker);
      for (const s of stops) s();
    };
  }, [on, sessionKey]);

  return (
    <div>
      <label>
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => setOn(e.target.checked)}
        />{" "}
        Help fund private orders while the app is open
      </label>
      <p className="muted">
        Your session key submits other people's withdrawals and is paid for each
        one. The fee starts at what the gas costs and climbs until someone takes
        it, so you only ever take a job that's worth doing. It's paid into the
        vault, where it shields like any other earnings.
      </p>
      {on && (
        <ul className="muted">
          {log.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
