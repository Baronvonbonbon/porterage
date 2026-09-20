// Helping fund other people's private orders (docs/PLAN.md §5.3): while this is
// on, the driver's session key submits funding requests it hears on the
// Statement Store and is tipped by each burner it funds. No taps: the session
// key signs, and it only pays gas.

import { useEffect, useRef, useState } from "react";
import type { Wallet } from "ethers";
import { SHIELD_POOL } from "../config";
import { addressOf, deployed } from "../contracts";
import { ethProvider } from "../contracts";
import { subscribeRequests } from "../market/statements";
import { submitPayout, submitRequest } from "../market/submit";
import { errorText, short } from "../format";

export function Helper({ sessionKey }: { sessionKey: Wallet }) {
  const [on, setOn] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const queue = useRef(Promise.resolve());

  useEffect(() => {
    if (!on) return;
    const signer = sessionKey.connect(ethProvider());
    const note = (line: string) => setLog((l) => [`${new Date().toLocaleTimeString()} ${line}`, ...l].slice(0, 8));
    let stop: (() => void) | null = null;
    // One at a time, so the session key's nonces don't collide.
    const run = (what: string, job: () => Promise<{ status: string; hash?: string; reason?: string }>) => {
      queue.current = queue.current.then(async () => {
        try {
          const r = await job();
          if (r.status === "sent") note(`${what} (tx ${short(r.hash!)})`);
          else if (r.reason !== "already handled") note(`skipped ${what}: ${r.reason}`);
        } catch (e) {
          note(`failed ${what}: ${errorText(e)}`);
        }
      });
    };
    subscribeRequests({
      fund: (req) => run(`funded ${short(req.proof.recipient)}`, () => submitRequest(req, SHIELD_POOL, signer)),
      payout: (req) =>
        deployed() && run("released a payout", () => submitPayout(req, addressOf("vault"), signer)),
    })
      .then((s) => (stop = s))
      .catch((e) => note(errorText(e)));
    note("listening for funding requests");
    return () => stop?.();
  }, [on, sessionKey]);

  return (
    <div>
      <label>
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> Help fund private orders
        while the app is open
      </label>
      <p className="muted">Your session key submits other people's withdrawals and is tipped for each one.</p>
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
