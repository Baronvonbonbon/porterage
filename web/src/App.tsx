import { useEffect, useState } from "react";
import { inHost } from "./host";
import { followHostTheme } from "./theme";
import { deployed } from "./contracts";
import { Driver } from "./views/Driver";
import { Customer } from "./views/customer/Customer";
import { Venue } from "./views/Venue";
import { Ops } from "./views/Ops";
import { Probe } from "./views/Probe";
import { SHAPE } from "./copy/privacy";
import { TrayProvider } from "./views/Tray";
import { Mark } from "./Mark";

type Role = "customer" | "driver" | "venue" | "ops" | "probe";
const ROLE_KEY = "porterage.role";

function savedRole(): Role | null {
  try {
    const r = localStorage.getItem(ROLE_KEY);
    // "probe" belongs here for a reason: if a probe navigates the WebView
    // away, the app restarts, and it has to come back to the screen that
    // knows a probe was in flight (probe.ts).
    return r === "customer" ||
      r === "driver" ||
      r === "venue" ||
      r === "ops" ||
      r === "probe"
      ? r
      : null;
  } catch {
    return null;
  }
}

export function App() {
  const [host, setHost] = useState<boolean | null>(null);
  const [role, setRole] = useState<Role | null>(savedRole);

  useEffect(() => {
    inHost().then(setHost);
  }, []);

  useEffect(() => {
    let stop: (() => void) | null = null;
    followHostTheme().then((s) => (stop = s));
    return () => stop?.();
  }, []);

  const choose = (r: Role | null) => {
    setRole(r);
    try {
      if (r) localStorage.setItem(ROLE_KEY, r);
      else localStorage.removeItem(ROLE_KEY);
    } catch {
      /* private mode: the choice just isn't remembered */
    }
  };

  return (
    <TrayProvider>
      <main>
        <header>
          <h1>
            <Mark size={22} />
            Porterage
          </h1>
          {role && (
            <button className="link" onClick={() => choose(null)}>
              Switch role
            </button>
          )}
        </header>

        {host === false && (
          <p className="notice">
            You're outside the Polkadot app, so there's no account to act with.
            Open <b>porterage.dot</b> in the Polkadot app to take part.
          </p>
        )}
        {!deployed() && (
          <p className="notice">
            The contracts aren't deployed yet, so nothing on-chain works.
          </p>
        )}

        {!role && (
          <section className="roles">
            <p>How are you using Porterage?</p>
            <button onClick={() => choose("customer")}>
              <b>Order</b>
              <span>Get something delivered</span>
            </button>
            <button onClick={() => choose("driver")}>
              <b>Drive</b>
              <span>Deliver orders for a fare</span>
            </button>
            <button onClick={() => choose("venue")}>
              <b>Sell</b>
              <span>Take orders at your venue</span>
            </button>
            {/* Not a fourth role: it's the arbiter's queue, and it's read-only
                unless this device holds the arbiter's key. Meant for Desktop. */}
            <button className="link" onClick={() => choose("ops")}>
              Operations console
            </button>
            {/* Not a role either: four measurements that need a real phone,
                which is why they have sat in the backlog (probe.ts). */}
            <button className="link" onClick={() => choose("probe")}>
              Check this phone
            </button>
            {/* Said once, on the only screen nobody is mid-task on. Every
                screen after this says its own share of it (copy/privacy.ts). */}
            <p className="muted">{SHAPE}</p>
          </section>
        )}

        {role === "driver" && <Driver />}
        {role === "customer" && <Customer />}
        {role === "venue" && <Venue />}
        {role === "ops" && <Ops />}
        {role === "probe" && <Probe />}
      </main>
    </TrayProvider>
  );
}
