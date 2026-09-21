// Money in and money out, for a role that is not the customer.
//
// The customer has a whole Wallet because their shielded balance is also the
// thing that funds orders, so notes, buckets and burners are all on screen. A
// driver or a venue does not need any of that. They need two doors: put money
// in, take money out. So this is deliberately not the Wallet — same machinery
// underneath, a tenth of the surface.
//
// The one piece of real design here is that cashing out STOPS at an unlinked
// account. It would be one line to carry straight on into the person's own
// wallet, and every other delivery app does exactly that. Here it would throw
// away the thing the withdrawal just bought: the account is unlinked, and
// paying a named address from it publishes the amount and the time against a
// name. So the private step happens on its own, and the step that costs
// privacy is a second button with the cost written beside it.

import { useCallback, useEffect, useState } from "react";
import { formatEther } from "ethers";
import { freeBalance, hostAccount, type HostAccount } from "../hostchain";
import { ethProvider } from "../contracts";
import { MAX_MARGIN_BPS, WITHDRAW_GAS } from "../market/auction";
import { describePlan, maxWithdrawable, planWithdrawal } from "../shield/plan";
import { allNotes, type NoteRecord } from "../shield/notes";
import { NoteBackup } from "./Backup";
import { planTopUp, topUp } from "../shield/deposit";
import {
  cashOut,
  cashOutBalances,
  sendOnward,
  sendableOf,
  type CashOutRecord,
  type CashOutStage,
} from "../shield/cashout";
import {
  CASH_OUT_PRIVATE,
  CASH_OUT_TIMING,
  sendOnwardCost,
} from "../copy/privacy";
import { errorText, pas, pasWei, short } from "../format";
import { pasOrNull } from "../money/amount";
import { Amount } from "./pickers/Amount";

const PLANCK_PER_WEI = 10n ** 8n;

type Kept = CashOutRecord & { balance: bigint };

const STAGE_TEXT: Record<CashOutStage, string> = {
  proving: "Making the proof on this phone. This is the slow part",
  posting: "Posting the request. Approve it in the Polkadot app if asked",
  waiting: "Waiting for someone online to submit it",
  settling: "Out. Recording the change",
  tipping: "Paying whoever submitted it",
  done: "Done",
};

export function Funds() {
  const [me, setMe] = useState<HostAccount | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [kept, setKept] = useState<Kept[]>([]);
  const [addAmount, setAddAmount] = useState("10");
  const [outAmount, setOutAmount] = useState("1");
  const [busy, setBusy] = useState<string | null>(null);
  const [stage, setStage] = useState<CashOutStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [gasPrice, setGasPrice] = useState(10n ** 12n);

  const refresh = useCallback(async () => {
    try {
      const acct = await hostAccount();
      setMe(acct);
      setBalance(await freeBalance(acct.address));
      setNotes(await allNotes());
      setKept(await cashOutBalances());
      setGasPrice((await ethProvider().getFeeData()).gasPrice ?? 10n ** 12n);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const spendable = notes.filter((n) => n.path && !n.spent);
  const shielded = spendable.reduce((a, n) => a + BigInt(n.value), 0n);

  // What can ACTUALLY come out, which is not the shielded total: every note
  // spent pays its own submitter, and a note worth less than that fee makes
  // the answer smaller rather than larger. Showing the raw total here is what
  // let someone ask for 25 out of 57 and be told no.
  const ceiling = (WITHDRAW_GAS * gasPrice * MAX_MARGIN_BPS) / 10_000n;
  const most = maxWithdrawable(spendable, ceiling);
  const asking = pasOrNull(outAmount);
  const plan = asking ? planWithdrawal(asking, spendable, ceiling) : null;

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    setDone(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      setStage(null);
    }
  }

  const want = pasOrNull(addAmount);
  const topUpPlan = want ? planTopUp(want) : null;
  const canAdd =
    !!topUpPlan && balance !== null && topUpPlan.total / PLANCK_PER_WEI < balance;

  return (
    <div>
      <h3>Your money</h3>
      <dl>
        <dt>In your account</dt>
        <dd>{balance === null ? "…" : pas(balance)}</dd>
        <dt>Shielded</dt>
        <dd>{pasWei(shielded)}</dd>
      </dl>

      <h3>Put money in</h3>
      <p className="muted">
        Moves PAS from your account into the shield, as fixed-size notes. The
        chain records that you shielded it, never what you spend it on.
      </p>
      <div className="actions">
        <Amount
          label="Shield"
          value={addAmount}
          onChange={setAddAmount}
          presets={[5, 10, 25]}
        />
        <button
          className="primary"
          disabled={!!busy || !canAdd}
          onClick={() =>
            run(`Shielding ${topUpPlan ? pasWei(topUpPlan.total) : ""}`, async () => {
              const r = await topUp(want!);
              setDone(
                `Shielded ${pasWei(r.deposited)} as ${r.rungs.length} note${
                  r.rungs.length > 1 ? "s" : ""
                }.`
              );
            })
          }
        >
          Shield it
        </button>
      </div>
      {topUpPlan && !canAdd && balance !== null && (
        <p className="warn">
          Your account holds {pas(balance)}; this needs{" "}
          {pasWei(topUpPlan.total / PLANCK_PER_WEI)}.
        </p>
      )}

      <h3>Take money out</h3>
      <p className="muted">{CASH_OUT_PRIVATE}</p>
      <p className="muted">
        Most you can take out now: <b>{pasWei(most)}</b>. That's your{" "}
        {pasWei(shielded)} less the fee on each note it takes to get there.
      </p>
      <div className="actions">
        <Amount
          label="Take out"
          value={outAmount}
          onChange={setOutAmount}
          presets={[1, 5, 25]}
        />
        {most > 0n && (
          <button
            disabled={!!busy}
            onClick={() => setOutAmount(formatEther(most))}
          >
            All of it
          </button>
        )}
        <button
          className="primary"
          disabled={!!busy || !asking || !plan}
          onClick={() =>
            run("Taking it out", async () => {
              const r = await cashOut(pasOrNull(outAmount)!, setStage);
              setDone(`It's in ${short(r.address)}, and stays there.`);
            })
          }
        >
          Take it out
        </button>
      </div>
      {!!asking && !plan && most > 0n && (
        <p className="warn">
          {pasWei(asking)} is more than your notes can cover once each one's fee
          is counted. {pasWei(most)} is the most right now.
        </p>
      )}
      {plan && plan.notes.length > 1 && (
        <p className="warn">{describePlan(plan)}</p>
      )}
      {plan && (
        <p className="muted">
          Fees up to {pasWei(plan.fees)}, taken from what comes out.
        </p>
      )}
      {stage && <p className="muted">{STAGE_TEXT[stage]}…</p>}

      {kept.length > 0 && (
        <>
          <h3>Waiting for you</h3>
          <p className="muted">{CASH_OUT_TIMING}</p>
          <ul className="rows">
            {kept.map((k) => (
              <KeptRow
                key={k.burner}
                kept={k}
                to={me?.evm ?? null}
                busy={!!busy}
                onSend={(to) =>
                  run("Sending it on", async () => {
                    const r = await sendOnward(k, to);
                    setDone(`Sent ${pasWei(r.sent)} to ${short(to)}.`);
                  })
                }
              />
            ))}
          </ul>
        </>
      )}

      <NoteBackup />

      {busy && <p className="muted">{busy}…</p>}
      {done && <p className="ok">{done}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function KeptRow({
  kept,
  to,
  busy,
  onSend,
}: {
  kept: Kept;
  to: string | null;
  busy: boolean;
  onSend: (to: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const sendable = sendableOf(kept.balance);

  return (
    <li>
      <div>
        <b>{pasWei(kept.balance)}</b>{" "}
        <span className="muted" title={kept.address}>
          in {short(kept.address)}
        </span>
      </div>
      {kept.sentTo ? (
        <p className="muted">
          Sent to {short(kept.sentTo)}. That one is public now.
        </p>
      ) : sendable === 0n ? (
        <p className="muted">Not enough here to cover sending it on.</p>
      ) : !asking ? (
        <div className="actions">
          <button disabled={busy} onClick={() => setAsking(true)}>
            Send to my wallet
          </button>
        </div>
      ) : (
        <>
          <p className="warn">{sendOnwardCost(to ? short(to) : "that wallet")}</p>
          <div className="actions">
            <button
              className="primary"
              disabled={busy || !to}
              onClick={() => to && onSend(to)}
            >
              Send {pasWei(sendable)}
            </button>
            <button disabled={busy} onClick={() => setAsking(false)}>
              Keep it here
            </button>
          </div>
        </>
      )}
    </li>
  );
}
