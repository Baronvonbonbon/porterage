// Is anyone out there submitting?
//
// The one question an operator cannot answer when someone says their
// withdrawal is stuck. The app's own message — "no one has submitted the
// request yet" — is true and tells you nothing about which of the three
// possible causes it is: nobody running a helper, a fee too low for the ones
// who are, or a request that is being refused on its merits.
//
// This distinguishes them. A request that sits while others clear is being
// refused; requests piling up with nothing clearing is an empty market.

import { useEffect, useState } from "react";
import {
  describeAmount,
  emptyHealth,
  verdict,
  watchMarket,
  type Health,
} from "../ops/market";
import { short } from "../format";

export function MarketHealth() {
  const [health, setHealth] = useState<Health>(emptyHealth());
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!on) return;
    let stop: (() => void) | null = null;
    watchMarket(setHealth)
      .then((s) => (stop = s))
      .catch(() => undefined);
    return () => stop?.();
  }, [on]);

  const v = verdict(health);

  return (
    <div>
      <h3>The funding market</h3>
      <p className="muted">
        Withdrawals are submitted by whoever is online, so "is anyone there" is
        a real question with a real answer. This watches requests going up and
        submissions landing, from the moment you switch it on.
      </p>
      <label>
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => setOn(e.target.checked)}
        />{" "}
        Watch the market
      </label>

      {on && (
        <>
          <p className={v.tone}>{v.text}</p>
          <dl>
            <dt>Waiting</dt>
            <dd>{health.waiting.length}</dd>
            <dt>Cleared</dt>
            <dd>{health.cleared.length}</dd>
            <dt>Submitters</dt>
            <dd>{health.submitters.length}</dd>
            <dt>Typical wait</dt>
            <dd>
              {health.medianWaitS === null
                ? "—"
                : `${health.medianWaitS.toFixed(0)} s`}
            </dd>
          </dl>

          {health.waiting.length > 0 && (
            <>
              <h3>Still waiting</h3>
              <ul className="rows">
                {health.waiting.map((p) => (
                  <li key={p.recipient}>
                    <div>
                      <b>{describeAmount(p.amount)}</b>{" "}
                      <span className="muted" title={p.recipient}>
                        to {short(p.recipient)}
                      </span>
                    </div>
                    <p className="muted">
                      {Math.round((Date.now() - p.seenAt) / 1000)} s, offering{" "}
                      {describeAmount(p.offering)}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}

          {health.submitters.length > 0 && (
            <>
              <h3>Who's submitting</h3>
              <ul className="muted">
                {health.submitters.map((s) => (
                  <li key={s} title={s}>
                    {short(s)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
