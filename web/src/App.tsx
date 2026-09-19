import { useEffect, useState } from "react";
import { inHost } from "./host";
import { deployed } from "./contracts";
import { Driver } from "./views/Driver";
import { Soon } from "./views/Soon";

type Role = "customer" | "driver" | "venue";
const ROLE_KEY = "porterage.role";

function savedRole(): Role | null {
  try {
    const r = localStorage.getItem(ROLE_KEY);
    return r === "customer" || r === "driver" || r === "venue" ? r : null;
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
          You're outside the Polkadot app, so there's no account to act with. Open <b>porterage.dot</b> in the
          Polkadot app to take part.
        </p>
      )}
      {!deployed() && <p className="notice">The contracts aren't deployed yet, so nothing on-chain works.</p>}

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
        </section>
      )}

      {role === "driver" && <Driver />}
      {role === "customer" && (
        <Soon title="Ordering">
          Customers order from a fresh private account each time, funded through Kusama Shield. That arrives with
          the money phase of the plan.
        </Soon>
      )}
      {role === "venue" && (
        <Soon title="Selling">
          Venue registration, menus and the pickup QR arrive with the delivery phase of the plan.
        </Soon>
      )}
    </main>
  );
}
