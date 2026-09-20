import { useEffect, useState } from "react";
import { inHost } from "./host";
import { followHostTheme } from "./theme";
import { deployed } from "./contracts";
import { Driver } from "./views/Driver";
import { Ordering } from "./views/Ordering";
import { Venue } from "./views/Venue";
import { Wallet } from "./views/Wallet";
import { Ops } from "./views/Ops";

type Role = "customer" | "driver" | "venue" | "ops";
const ROLE_KEY = "porterage.role";

function savedRole(): Role | null {
  try {
    const r = localStorage.getItem(ROLE_KEY);
    return r === "customer" || r === "driver" || r === "venue" || r === "ops"
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
    <main>
      <header>
        <h1>Porterage</h1>
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
        </section>
      )}

      {role === "driver" && <Driver />}
      {role === "customer" && (
        <>
          <Wallet />
          <Ordering />
        </>
      )}
      {role === "venue" && <Venue />}
      {role === "ops" && <Ops />}
    </main>
  );
}
