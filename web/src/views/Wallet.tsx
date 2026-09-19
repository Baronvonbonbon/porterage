// The customer's shielded wallet (docs/PLAN.md §5.2): PAS moved from the host
// account into Kusama Shield as fixed-size notes, ready to fund orders later
// from fresh burners that nothing links back to this account.

import { useCallback, useEffect, useState } from "react";
import { parseEther } from "ethers";
import { freeBalance, hostAccount, type HostAccount } from "../hostchain";
import { allNotes, type NoteRecord } from "../shield/notes";
import { planTopUp, topUp } from "../shield/deposit";
import { errorText, pas, pasWei, short } from "../format";

const PLANCK_PER_WEI = 10n ** 8n;

function parsePas(s: string): bigint | null {
  try {
    const v = parseEther(s.trim() || "0");
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

export function Wallet() {
  const [me, setMe] = useState<HostAccount | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [amount, setAmount] = useState("10");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const acct = await hostAccount();
      setMe(acct);
      setBalance(await freeBalance(acct.address));
      setNotes(await allNotes());
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const unspent = notes.filter((n) => n.path && !n.spent);
  const pending = notes.filter((n) => n.pendingSince);
  const shielded = unspent.reduce((a, n) => a + BigInt(n.value), 0n);
  const byRung = new Map<string, number>();
  for (const n of unspent) byRung.set(n.value, (byRung.get(n.value) ?? 0) + 1);

  const want = parsePas(amount);
  const plan = want ? planTopUp(want) : null;
  const affordable = plan && balance !== null && plan.total / PLANCK_PER_WEI < balance;

  async function shield() {
    if (!plan || !want) return;
    setBusy(`Shielding ${pasWei(plan.total)}`);
    setError(null);
    setDone(null);
    try {
      const r = await topUp(want);
      setDone(`Shielded ${pasWei(r.deposited)} as ${r.rungs.length} note${r.rungs.length > 1 ? "s" : ""} (block ${r.block}).`);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h2>Private balance</h2>
      <p className="muted">
        Orders are paid from a fresh account each time, funded from here through Kusama Shield, so nothing on-chain
        links an order to you.
      </p>

      <dl>
        <dt>Your account</dt>
        <dd title={me?.address}>{me ? short(me.address) : "…"}</dd>
        <dt>Balance</dt>
        <dd>{balance === null ? "…" : pas(balance)}</dd>
        <dt>Shielded</dt>
        <dd>
          {pasWei(shielded)}
          {unspent.length > 0 && (
            <span className="muted">
              {" "}
              in{" "}
              {[...byRung.entries()]
                .sort(([a], [b]) => (BigInt(a) > BigInt(b) ? -1 : 1))
                .map(([v, c]) => `${c} × ${pasWei(BigInt(v)).replace(".0000", "")}`)
                .join(", ")}
            </span>
          )}
        </dd>
        {pending.length > 0 && (
          <>
            <dt>Unconfirmed</dt>
            <dd className="warn">
              {pending.length} note{pending.length > 1 ? "s" : ""} sent without a confirmation. They're recoverable from
              the pool.
            </dd>
          </>
        )}
      </dl>

      <div className="actions">
        <label>
          Shield{" "}
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} size={6} /> PAS
        </label>
        {plan && (
          <p className="muted">
            Deposits {pasWei(plan.total)} as {plan.rungs.map((r) => pasWei(r).replace(".0000", "")).join(" + ")}.
            {plan.overshoot > 0n && ` That's ${pasWei(plan.overshoot)} over, to fit the fixed note sizes.`}
          </p>
        )}
        <button disabled={!!busy || !affordable} onClick={shield}>
          {plan ? `Shield ${pasWei(plan.total)}` : "Shield"}
        </button>
        {plan && balance !== null && !affordable && <p className="warn">That's more than your account holds.</p>}
      </div>

      <p className="muted">
        Shield well ahead of ordering. A deposit followed minutes later by a spend of the same notes is easy to match
        up; hours or days apart, with other people's deposits in between, it isn't.
      </p>

      {busy && <p className="muted">{busy}… approve it in the Polkadot app.</p>}
      {done && <p className="ok">{done}</p>}
      {error && <p className="error">{error}</p>}
      <button className="link" onClick={refresh} disabled={!!busy}>
        Refresh
      </button>
    </section>
  );
}
