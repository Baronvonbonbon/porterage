// The customer's shielded wallet (docs/PLAN.md §5.2): PAS moved from the host
// account into Kusama Shield as fixed-size notes, ready to fund orders later
// from fresh burners that nothing links back to this account.

import { useCallback, useEffect, useState } from "react";
import { parseEther } from "ethers";
import { freeBalance, hostAccount, type HostAccount } from "../hostchain";
import { ethProvider } from "../contracts";
import { MAX_MARGIN_BPS, WITHDRAW_GAS } from "../market/auction";
import { maxWithdrawable } from "../shield/plan";
import { allNotes, type NoteRecord } from "../shield/notes";
import {
  MAX_NOTES_PER_TAP,
  planTopUp,
  topUp,
  topUpFromToken,
} from "../shield/deposit";
import { TOKENS, formatUnits, parseUnits, type Token } from "../money/tokens";
import { locationOf, quote, spendableToken, PAS_LOCATION } from "../money/swap";
import {
  fundBurner,
  resumeFunding,
  type FundStage,
  type Funded,
} from "../shield/fund";
import { errorText, pas, pasWei, short } from "../format";
import { Choose } from "./pickers/Choose";
import { Amount } from "./pickers/Amount";
import { pasOrNull } from "../money/amount";

const PLANCK_PER_WEI = 10n ** 8n;

export function Wallet() {
  const [me, setMe] = useState<HostAccount | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [amount, setAmount] = useState("10");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [fundAmount, setFundAmount] = useState("1");
  const [stage, setStage] = useState<{ stage: FundStage; at: number } | null>(
    null
  );
  const [proveMs, setProveMs] = useState<number | null>(null);
  const [funded, setFunded] = useState<Funded | null>(null);
  const [source, setSource] = useState<Token | null>(null); // null = PAS
  const [held, setHeld] = useState<Map<number, bigint>>(new Map());
  const [swapQuote, setSwapQuote] = useState<bigint | null>(null);
  const [gasPrice, setGasPrice] = useState(10n ** 12n);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const acct = await hostAccount();
      setMe(acct);
      setBalance(await freeBalance(acct.address));
      setNotes(await allNotes());
      setGasPrice((await ethProvider().getFeeData()).gasPrice ?? 10n ** 12n);
      setHeld(
        new Map(
          await Promise.all(
            TOKENS.map(
              async (t) =>
                [t.id, await spendableToken(t, acct.address)] as const
            )
          )
        )
      );
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    resumeFunding()
      .then((r) => {
        if (r.length) {
          setFunded(r[r.length - 1]);
          refresh();
        }
      })
      .catch((e) => setError(`resuming a funding request: ${errorText(e)}`));
  }, [refresh]);

  const unspent = notes.filter((n) => n.path && !n.spent);
  // Not the shielded total: each note spent pays its own submitter, so the
  // real ceiling is lower and a note smaller than that fee lowers it further.
  const mostFundable = maxWithdrawable(
    unspent,
    (WITHDRAW_GAS * gasPrice * MAX_MARGIN_BPS) / 10_000n
  );
  const pending = notes.filter((n) => n.pendingSince);
  const shielded = unspent.reduce((a, n) => a + BigInt(n.value), 0n);
  const byRung = new Map<string, number>();
  for (const n of unspent) byRung.set(n.value, (byRung.get(n.value) ?? 0) + 1);

  const want = source ? parseUnits(amount, source.decimals) : pasOrNull(amount);
  const plan =
    !source && want
      ? planTopUp(want)
      : swapQuote
      ? planTopUp(swapQuote * PLANCK_PER_WEI)
      : null;
  const affordable = source
    ? !!want && want <= (held.get(source.id) ?? 0n)
    : !!plan && balance !== null && plan.total / PLANCK_PER_WEI < balance;

  // Quote a token amount whenever it changes, so the notes shown are the real ones.
  useEffect(() => {
    if (!source || !want) {
      setSwapQuote(null);
      return;
    }
    let live = true;
    quote(locationOf(source.id), PAS_LOCATION, want)
      .then((q) => live && setSwapQuote(q))
      .catch(() => live && setSwapQuote(null));
    return () => {
      live = false;
    };
  }, [source, amount, want]);

  async function shield() {
    if (!plan || !want) return;
    setBusy(`Shielding ${pasWei(plan.total)}`);
    setError(null);
    setDone(null);
    try {
      const r = source ? await topUpFromToken(source, want) : await topUp(want);
      setDone(
        `Shielded ${pasWei(r.deposited)} as ${r.rungs.length} note${
          r.rungs.length > 1 ? "s" : ""
        } (block ${r.block}).` +
          (r.leftOver > 0n
            ? ` ${pasWei(
                r.leftOver
              )} stayed in your account: only ${MAX_NOTES_PER_TAP} notes fit in one tap.`
            : "")
      );
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function fund() {
    const want = pasOrNull(fundAmount);
    if (!want) return;
    setError(null);
    setFunded(null);
    setProveMs(null);
    let provingFrom = 0;
    try {
      const r = await fundBurner(want, (s) => {
        const now = performance.now();
        if (s === "proving") provingFrom = now;
        if (s === "posting") setProveMs(Math.round(now - provingFrom));
        setStage({ stage: s, at: now });
      });
      setFunded(r);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setStage(null);
    }
  }

  const STAGE_TEXT: Record<FundStage, string> = {
    proving: "Making the withdrawal proof on this phone. This is the slow part",
    posting: "Posting the request. Approve it in the Polkadot app if asked",
    waiting: "Waiting for someone online to submit it",
    settling: "Funded. Recording the change note",
    tipping: "Tipping whoever submitted it, from the new account",
    done: "Done",
  };

  return (
    <section>
      <h2>Private balance</h2>
      <p className="muted">
        Orders are paid from a fresh account each time, funded from here through
        Kusama Shield, so nothing on-chain links an order to you.
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
                .map(
                  ([v, c]) => `${c} × ${pasWei(BigInt(v)).replace(".0000", "")}`
                )
                .join(", ")}
            </span>
          )}
        </dd>
        {pending.length > 0 && (
          <>
            <dt>Unconfirmed</dt>
            <dd className="warn">
              {pending.length} note{pending.length > 1 ? "s" : ""} sent without
              a confirmation. They're recoverable from the pool.
            </dd>
          </>
        )}
      </dl>

      <div className="actions">
        <Amount
          label="Shield"
          value={amount}
          onChange={setAmount}
          presets={[5, 10, 25]}
        />
        <Choose
          label="What to shield"
          value={source?.id ?? 0}
          onPick={(id) => {
            setSource(TOKENS.find((t) => t.id === id) ?? null);
            setAmount("10");
          }}
          choices={[
            { value: 0, label: "PAS" },
            ...TOKENS.map((t) => ({
              value: t.id,
              label: t.symbol,
              disabled: !(held.get(t.id) ?? 0n),
              note: held.get(t.id)
                ? `(${formatUnits(held.get(t.id)!, t.decimals)})`
                : "— none",
            })),
          ]}
        />
        {source && (
          <p className="muted">
            {swapQuote === null
              ? "…"
              : `Swaps to about ${pas(
                  swapQuote
                )} first. That swap is public, and happens before anything is hidden.`}
          </p>
        )}
        {plan && (
          <p className="muted">
            Deposits {pasWei(plan.total)} as{" "}
            {plan.rungs.map((r) => pasWei(r).replace(".0000", "")).join(" + ")}.
            {plan.overshoot > 0n &&
              ` That's ${pasWei(
                plan.overshoot
              )} over, to fit the fixed note sizes.`}
          </p>
        )}
        <button
          className="primary"
          disabled={!!busy || !affordable}
          onClick={shield}
        >
          {plan ? `Shield ${pasWei(plan.total)}` : "Shield"}
        </button>
        {plan && balance !== null && !affordable && (
          <p className="warn">That's more than your account holds.</p>
        )}
      </div>

      <p className="muted">
        Shield well ahead of ordering. A deposit followed minutes later by a
        spend of the same notes is easy to match up; hours or days apart, with
        other people's deposits in between, it isn't.
      </p>

      <h3>Try a private account</h3>
      <p className="muted">
        Each order gets a fresh account funded from your notes, with nothing
        on-chain linking it to you. Each note spent pays a fee to whoever
        submits its withdrawal: the fee opens at their cost and climbs for 30
        seconds until someone takes it, capped at four times the gas. Whatever
        it doesn't reach stays with the account and pays its own fees.
      </p>
      <p className="muted">
        Most you can fund right now: <b>{pasWei(mostFundable)}</b>. An amount
        bigger than one note takes several withdrawals, one fee each.
      </p>
      <div className="actions">
        <Amount
          label="Fund with"
          value={fundAmount}
          onChange={setFundAmount}
          presets={[1, 5, 10]}
        />
        <button
          disabled={!!busy || !!stage || !pasOrNull(fundAmount)}
          onClick={fund}
        >
          Fund a private account
        </button>
      </div>
      {stage && <p className="muted">{STAGE_TEXT[stage.stage]}…</p>}
      {proveMs !== null && (
        <p className="muted">
          The proof took {(proveMs / 1000).toFixed(1)} s on this phone.
        </p>
      )}
      {funded && (
        <p className="ok">
          Private account {short(funded.burner.address)} holds{" "}
          {pasWei(funded.received)}.
          {funded.submitter
            ? ` Submitted by ${short(funded.submitter)}${
                funded.tipped ? ", tipped" : ""
              }.`
            : ""}
        </p>
      )}

      {busy && <p className="muted">{busy}… approve it in the Polkadot app.</p>}
      {done && <p className="ok">{done}</p>}
      {error && <p className="error">{error}</p>}
      <button className="link" onClick={refresh} disabled={!!busy}>
        Refresh
      </button>
    </section>
  );
}
