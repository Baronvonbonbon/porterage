// The operations console (docs/PLAN.md §6, Phase 6).
//
// Meant for Desktop, where there's a keyboard and a paired account, but it is
// the same Product — there is no second app to install.
//
// It always shows the queue, because a dispute's existence, its order and the
// driver's record are on-chain and public anyway. What it will not pretend is
// authority: a ruling can only be signed by the key the contract names as the
// arbiter, and a case can only be READ by that key, because it was sealed to
// it. So the console works out whether this device holds that key and says so
// plainly, rather than offering buttons that would revert.
//
// The arbiter key is secp256k1 (keys.ts `opsKey`), not the host account: a case
// is sealed by ECDH on that curve, and an sr25519 account cannot take part.

import { useCallback, useEffect, useState } from "react";
import { formatEther, parseEther, type Wallet } from "ethers";
import { Contract } from "ethers";
import { ABI, addressOf, ethProvider, read } from "../contracts";
import { opsKey } from "../keys";
import { arbiterAddress } from "../order/arbiter";
import { openCase, type Case } from "../order/dispute";
import { queue, paused, type QueueRow } from "../ops/queue";
import { bondGoesTo, slashExceedsStake, splitEscrow } from "../ops/ruling";
import { evidenceFor } from "../order/dispute";
import { asDataUrl, unpackAlbum } from "../order/evidence";
import { errorText, pasWei, short } from "../format";
import { NOT_ARBITER } from "../copy/privacy";
import { Earnings } from "./Earnings";
import { Funds } from "./Funds";
import { Controls } from "./Controls";
import { MarketHealth } from "./MarketHealth";

export function Ops() {
  const [key, setKey] = useState<Wallet | null>(null);
  const [arbiter, setArbiter] = useState<string | null>(null);
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [shut, setShut] = useState<number[]>([]);
  const [openOnly, setOpenOnly] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showing, setShowing] = useState<bigint | null>(null);
  const [papers, setPapers] = useState<Case | null>(null);
  /** Every photo in the album — a driver may have sent one at the counter
   *  and one at the door, both under the one evidence key. */
  const [photos, setPhotos] = useState<string[]>([]);
  const [share, setShare] = useState("5000");
  const [slash, setSlash] = useState("0");
  const [openerWins, setOpenerWins] = useState(true);
  const [atFault, setAtFault] = useState(false);

  const mine =
    !!key && !!arbiter && key.address.toLowerCase() === arbiter.toLowerCase();

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [k, a] = await Promise.all([opsKey(), arbiterAddress()]);
      setKey(k);
      setArbiter(a);
      setRows(await queue(20, openOnly));
      setShut(await paused());
    } catch (e) {
      setError(errorText(e));
    }
  }, [openOnly]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const row = rows.find((r) => r.disputeId === showing) ?? null;

  /** Open the sealed case, and the photo it encloses if there is one. */
  async function look(r: QueueRow) {
    setShowing(r.disputeId);
    setPapers(null);
    setPhotos([]);
    if (!key || !mine) return;
    setBusy(`Opening #${r.disputeId}`);
    setError(null);
    try {
      const c = await openCase(key, r.evidenceURI);
      setPapers(c);
      // The photo the OTHER party committed is the one worth looking at, and
      // the key in the case is what opens it.
      const other = r.evidence.find(
        (e) => e.party.toLowerCase() !== r.opener.toLowerCase()
      );
      if (c?.photoKey && other) {
        const found = await evidenceFor(
          r.orderId,
          other.party,
          c.photoKey
        ).catch(() => null);
        if (found) setPhotos(unpackAlbum(found.photo).map(asDataUrl));
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function rule() {
    if (!row || !key) return;
    const bps = Number(share);
    let split;
    try {
      split = splitEscrow(row.escrow, bps);
    } catch (e) {
      setError(errorText(e));
      return;
    }
    setBusy(`Ruling on #${row.disputeId}`);
    setError(null);
    try {
      const disputes = new Contract(
        addressOf("disputes"),
        ABI.disputes.fragments as never,
        key.connect(ethProvider())
      );
      await (
        await disputes.resolve(
          row.disputeId,
          bps,
          openerWins,
          atFault,
          parseEther(slash || "0")
        )
      ).wait();
      setNote(
        `Ruled on #${row.disputeId}: customer ${pasWei(
          split.customerAmt
        )}, driver ${pasWei(split.driverAmt)}.`
      );
      setShowing(null);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const preview = (() => {
    if (!row) return null;
    try {
      return splitEscrow(row.escrow, Number(share));
    } catch {
      return null;
    }
  })();

  return (
    <section>
      <h2>Operations</h2>

      <dl>
        <dt>Arbiter</dt>
        <dd title={arbiter ?? ""}>{arbiter ? short(arbiter) : "…"}</dd>
        <dt>This device</dt>
        <dd title={key?.address ?? ""}>
          {key ? short(key.address) : "…"}{" "}
          {mine ? <span className="ok">— the arbiter</span> : ""}
        </dd>
        {shut.length > 0 && (
          <>
            <dt>Paused</dt>
            <dd className="warn">categories {shut.join(", ")}</dd>
          </>
        )}
      </dl>

      <Controls signer={key} />

      <MarketHealth />

      <Treasury />

      {!mine && (
        <p className="notice">
          {NOT_ARBITER} To make this device the arbiter, point the contract at
          the key above and rebuild the app with its public key.
        </p>
      )}

      <div className="actions">
        <button className="link" onClick={() => setOpenOnly(!openOnly)}>
          {openOnly ? "Show settled ones too" : "Only the open ones"}
        </button>
        <button className="link" disabled={!!busy} onClick={refresh}>
          Refresh
        </button>
      </div>

      {rows.length === 0 && (
        <p className="muted">
          {openOnly ? "No disputes are open." : "No disputes yet."}
        </p>
      )}

      <ul>
        {rows.map((r) => (
          <li key={r.disputeId.toString()}>
            <b>#{r.disputeId.toString()}</b> on order #{r.orderId.toString()} —{" "}
            {r.orderStatus}, escrow {pasWei(r.escrow)}, opened by{" "}
            {short(r.opener)}
            {r.status === 2 && " — settled"}
            <br />
            <span className="muted">
              driver{" "}
              {r.driver === `0x${"0".repeat(40)}` ? "none" : short(r.driver)},{" "}
              {r.delivered} delivered / {r.failed} failed, staked{" "}
              {pasWei(r.driverStake)} — {r.evidence.length} photo
              {r.evidence.length === 1 ? "" : "s"} committed
            </span>{" "}
            <button
              className="link"
              disabled={!!busy}
              onClick={() =>
                showing === r.disputeId ? setShowing(null) : look(r)
              }
            >
              {showing === r.disputeId ? "close" : "open"}
            </button>
            {showing === r.disputeId && (
              <div className="thread">
                {papers ? (
                  <>
                    <p>
                      <b>“{papers.reason}”</b>
                    </p>
                    {papers.photoKey && photos.length === 0 && (
                      <p className="muted">
                        A photo key came with it; nothing loaded.
                      </p>
                    )}
                    {photos.map((src, i) => (
                      <img
                        key={i}
                        className="evidence"
                        src={src}
                        alt={
                          photos.length > 1
                            ? `evidence ${i + 1} of ${photos.length}`
                            : "the evidence"
                        }
                      />
                    ))}
                  </>
                ) : (
                  <p className="muted">
                    {mine ? "…" : "Sealed to the arbiter."}
                  </p>
                )}

                {r.status === 1 && mine && (
                  <>
                    <label>
                      Customer's share, in basis points{" "}
                      <input
                        inputMode="numeric"
                        size={6}
                        value={share}
                        onChange={(e) => setShare(e.target.value)}
                      />
                    </label>
                    <p className={preview ? "muted" : "error"}>
                      {preview
                        ? `Customer ${pasWei(
                            preview.customerAmt
                          )}, driver ${pasWei(
                            preview.driverAmt
                          )} — exactly what the contract will do.`
                        : "That share is outside 0–10000, and the contract would refuse it."}
                    </p>
                    <label>
                      Slash from the driver's stake, in PAS{" "}
                      <input
                        inputMode="decimal"
                        size={6}
                        value={slash}
                        onChange={(e) => setSlash(e.target.value)}
                      />
                    </label>
                    {(() => {
                      let asked = 0n;
                      try {
                        asked = parseEther(slash || "0");
                      } catch {
                        return <p className="error">That isn't an amount.</p>;
                      }
                      return slashExceedsStake(asked, r.driverStake) ? (
                        <p className="warn">
                          More than the {pasWei(r.driverStake)} staked. The
                          contract takes what's there and the rest never
                          arrives.
                        </p>
                      ) : null;
                    })()}
                    <label>
                      <input
                        type="checkbox"
                        checked={openerWins}
                        onChange={(e) => setOpenerWins(e.target.checked)}
                      />{" "}
                      The bond goes {bondGoesTo(openerWins)}
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={atFault}
                        onChange={(e) => setAtFault(e.target.checked)}
                      />{" "}
                      Mark the driver at fault
                    </label>
                    <div className="actions">
                      <button
                        className="primary"
                        disabled={!!busy || !preview}
                        onClick={rule}
                      >
                        Rule on #{r.disputeId.toString()}
                      </button>
                    </div>
                    <p className="warn">A ruling can't be taken back.</p>
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      {busy && <p className="muted">{busy}…</p>}
      {note && <p className="ok">{note}</p>}
      {error && <p className="error">{error}</p>}
      <p className="muted">
        Rulings are signed by the arbiter's own key, which holds{" "}
        {key ? <Balance of={key.address} /> : "…"} for gas.
      </p>
    </section>
  );
}

function Balance({ of }: { of: string }) {
  const [pas, setPas] = useState<string>("…");
  useEffect(() => {
    let on = true;
    ethProvider()
      .getBalance(of)
      .then((b) => on && setPas(`${Number(formatEther(b)).toFixed(4)} PAS`))
      .catch(() => on && setPas("unknown"));
    return () => {
      on = false;
    };
  }, [of]);
  return <>{pas}</>;
}

/**
 * The protocol's own takings.
 *
 * Every order credits `feeBps` of the fare to the treasury, and until now
 * nothing in this app could see that, let alone shield it. Leaving it out was
 * the same leak the vault change closed for everyone else — it just happened to
 * be the operator's income rather than a driver's, which is exactly the reason
 * it was easy not to notice.
 *
 * On this testnet the treasury is the deploy key, which lives on a computer and
 * not on a phone, so most of the time this panel can only report. It says so
 * rather than offering a button that would fail: a screen that pretends to be
 * able to move money it cannot reach is worse than one that explains why.
 */
function Treasury() {
  const [treasury, setTreasury] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [key, setKey] = useState<Wallet | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const who = (await read("orders").treasury()) as string;
        setTreasury(who);
        setBalance(await read("vault").balanceOf(who));
        setKey(await opsKey());
      } catch {
        /* not deployed, or unreachable */
      }
    })();
  }, []);

  const ours =
    !!key && !!treasury && key.address.toLowerCase() === treasury.toLowerCase();

  return (
    <>
      <h3>Protocol fees</h3>
      <dl>
        <dt>Treasury</dt>
        <dd title={treasury ?? ""}>{treasury ? short(treasury) : "…"}</dd>
        <dt>Waiting in the vault</dt>
        <dd>{balance === null ? "…" : pasWei(balance)}</dd>
      </dl>
      {ours ? (
        <>
          <Earnings account={treasury!} />
          <Funds />
        </>
      ) : (
        <p className="muted">
          The treasury key isn't on this device, so this is a read-only view. It
          shields the same way everyone else's earnings do — a bucket at a time,
          from whichever device holds that key.
        </p>
      )}
    </>
  );
}
