// Driver onboarding (docs/PLAN.md §3).
//
// Three host taps, each a rare action: register with a session key, give the
// session key a little PAS for gas, and later rotate it if needed. After that
// the session key signs bids and handoffs with no taps at all.

import { useCallback, useEffect, useState } from "react";
import type { Wallet } from "ethers";
import {
  freeBalance,
  hostAccount,
  hostCall,
  hostFund,
  type HostAccount,
} from "../hostchain";
import { sessionKey, keySource, type KeySource } from "../keys";
import { addressOf, deployed, encode, ethProvider, read } from "../contracts";
import { errorText, pas, pasWei, short } from "../format";
import { Earnings } from "./Earnings";
import { Jobs } from "./Jobs";
import { Helper } from "./Helper";
import { Profile } from "./driver/Profile";

/** Gas for the session key: plenty for a few hundred bids and handoffs on Paseo. */
const SESSION_GAS_PLANCK = 5_000_000_000n; // 0.5 PAS
const SESSION_LOW_WEI = 100_000_000_000_000_000n; // 0.1 PAS

interface OnChain {
  registered: boolean;
  keyOnChain: string;
  delivered: number;
  failed: number;
}

type Step = "work" | "mine" | "earnings" | "setup";

export function Driver() {
  /**
   * Onboarding, the funding helper, the job list, the active delivery and the
   * earnings were all one page. A driver looking for work read past four other
   * things to find it, and a driver halfway through a delivery read past the
   * job list to find the delivery. One screen answers one question.
   *
   * It opens on Work, because that is what a driver opens the app for. Setup
   * is last: it matters once.
   */
  const [step, setStep] = useState<Step>("work");
  const [me, setMe] = useState<HostAccount | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [key, setKey] = useState<Wallet | null>(null);
  const [source, setSource] = useState<KeySource | null>(null);
  const [keyBalance, setKeyBalance] = useState<bigint | null>(null);
  const [chain, setChain] = useState<OnChain | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [acct, k, src] = await Promise.all([
        hostAccount(),
        sessionKey(0),
        keySource(),
      ]);
      setMe(acct);
      setKey(k);
      setSource(src);
      setBalance(await freeBalance(acct.address));
      setKeyBalance(await ethProvider().getBalance(k.address));
      if (deployed()) {
        const drivers = read("drivers");
        const d = await drivers.drivers(acct.evm);
        setChain({
          registered: d.registered,
          keyOnChain: await drivers.sessionKeyOf(acct.evm),
          delivered: Number(d.delivered),
          failed: Number(d.failed),
        });
      }
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

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

  const keyCurrent =
    !!key &&
    !!chain &&
    chain.keyOnChain.toLowerCase() === key.address.toLowerCase();
  const keyLow = keyBalance !== null && keyBalance < SESSION_LOW_WEI;

  // Everything below the bar needs a registered driver with a funded session
  // key. Until then the setup block is the whole screen, which is right: there
  // is nothing else a driver can do yet.
  const ready = !!(chain?.registered && keyCurrent && !keyLow);

  return (
    <section>
      <h2>Drive</h2>

      {ready && (
        <nav className="steps">
          {(
            [
              ["work", "Work"],
              ["mine", "Yours"],
              ["earnings", "Earnings"],
              ["setup", "Setup"],
            ] as [Step, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              className={step === id ? "on" : ""}
              onClick={() => setStep(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      )}

      {me && (!ready || step === "setup") && (
        <dl>
          <dt>Your account</dt>
          <dd title={me.address}>{short(me.address)}</dd>
          <dt>As contracts see it</dt>
          <dd title={me.evm}>{short(me.evm)}</dd>
          <dt>Balance</dt>
          <dd>{balance === null ? "…" : pas(balance)}</dd>
          <dt>Session key</dt>
          <dd title={key?.address}>
            {key ? short(key.address) : "…"}
            {source === "browser" && (
              <span className="warn"> (browser-held: development only)</span>
            )}
          </dd>
          <dt>Session key gas</dt>
          <dd>{keyBalance === null ? "…" : pasWei(keyBalance)}</dd>
          {chain?.registered && (
            <>
              <dt>Deliveries</dt>
              <dd>
                {chain.delivered} delivered, {chain.failed} failed
              </dd>
            </>
          )}
        </dl>
      )}

      {me && balance === 0n && (!ready || step === "setup") && (
        <p className="notice">
          Your account has no PAS. Get some from the Paseo faucet for{" "}
          <code>{me.address}</code>, then refresh.
        </p>
      )}

      {me && key && deployed() && chain && (!ready || step === "setup") && (
        <div className="actions">
          {!chain.registered && (
            <button
              className="primary"
              disabled={!!busy}
              onClick={() =>
                run("Registering", () =>
                  hostCall(
                    addressOf("drivers"),
                    encode("drivers", "registerWithSessionKey", [
                      "",
                      key.address,
                    ])
                  )
                )
              }
            >
              Register as a driver
            </button>
          )}
          {chain.registered && !keyCurrent && (
            <button
              disabled={!!busy}
              onClick={() =>
                run("Setting the session key", () =>
                  hostCall(
                    addressOf("drivers"),
                    encode("drivers", "setSessionKey", [key.address])
                  )
                )
              }
            >
              Use this phone's session key
            </button>
          )}
          {chain.registered && keyCurrent && keyLow && (
            <button
              disabled={!!busy}
              onClick={() =>
                run("Funding the session key", () =>
                  hostFund(key.address, SESSION_GAS_PLANCK)
                )
              }
            >
              Give the session key {pas(SESSION_GAS_PLANCK)} for gas
            </button>
          )}
          {chain.registered && keyCurrent && !keyLow && (
            <p className="ok">
              Ready. Bids and handoffs sign on this phone with no taps.
            </p>
          )}
        </div>
      )}

      {ready && key && me && (
        <>
          {step === "work" && (
            <Jobs sessionKey={key} driver={me.evm} show="work" />
          )}
          {step === "mine" && (
            <Jobs sessionKey={key} driver={me.evm} show="mine" />
          )}
          {step === "earnings" && <Earnings account={me.evm} />}
          {step === "setup" && (
            <>
              <Profile driver={me.evm} />
              <Helper sessionKey={key} />
            </>
          )}
        </>
      )}

      {busy && <p className="muted">{busy}… approve it in the Polkadot app.</p>}
      {error && <p className="error">{error}</p>}
      <button className="link" onClick={refresh} disabled={!!busy}>
        Refresh
      </button>
    </section>
  );
}
