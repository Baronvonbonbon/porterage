// A driver's or venue's earnings, and the private way out (docs/PLAN.md §5.6).

import { useCallback, useEffect, useState } from "react";
import { addressOf, ethProvider, read } from "../contracts";
import { bucketFor, buckets } from "../shield/payout";
import { releaseEarnings, shieldEarnings, type ReleaseStage } from "../shield/payoutFlow";
import { allPayouts, type PayoutRecord } from "../shield/notes";
import { errorText, pasWei } from "../format";

export function Earnings({ account }: { account: string }) {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [rungs, setRungs] = useState<bigint[]>([]);
  const [payouts, setPayouts] = useState<PayoutRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const vault = read("vault");
      setBalance(await vault.balanceOf(account));
      setRungs(await buckets(ethProvider(), addressOf("vault")));
      setPayouts(await allPayouts());
    } catch (e) {
      setError(errorText(e));
    }
  }, [account]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const bucket = balance === null ? null : bucketFor(balance, rungs);
  const waiting = payouts.filter((p) => p.insertedAt && p.spentInto === undefined);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const release = (p: PayoutRecord) =>
    run("Releasing", () =>
      releaseEarnings(p, (s: ReleaseStage) =>
        setBusy(
          {
            reading: "Reading the vault's notes",
            proving: "Proving on this phone",
            posting: "Posting it for someone to submit",
            waiting: "Waiting for a stranger to submit it",
            settling: "Recording your pool note",
            done: "Done",
          }[s],
        ),
      ),
    );

  return (
    <div>
      <h3>Earnings</h3>
      <dl>
        <dt>Paid to you</dt>
        <dd>{balance === null ? "…" : pasWei(balance)}</dd>
        {waiting.length > 0 && (
          <>
            <dt>Held as notes</dt>
            <dd>{waiting.map((p) => pasWei(BigInt(p.bucket))).join(", ")}</dd>
          </>
        )}
      </dl>

      <div className="actions">
        {bucket !== null && bucket > 0n && (
          <button disabled={!!busy} onClick={() => run("Shielding", () => shieldEarnings(bucket))}>
            Move {pasWei(bucket)} out of sight
          </button>
        )}
        {waiting.map((p) => (
          <button key={p.n} disabled={!!busy} onClick={() => release(p)}>
            Release {pasWei(BigInt(p.bucket))} into your private balance
          </button>
        ))}
      </div>

      <p className="muted">
        Two steps, and they work best apart. Moving earnings out of sight is signed by you, like any deposit. Releasing
        proves you own one note of many without saying which, and a stranger submits it, so nothing ties the money to
        you. Leave time between them.
      </p>

      {busy && <p className="muted">{busy}…</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
