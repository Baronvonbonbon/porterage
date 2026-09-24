import { Suspense, useEffect, useState } from "react";
import { inHost } from "./host";
import { followHostTheme } from "./theme";
import { deployed } from "./contracts";
import { rememberRole, savedRole, type Role } from "./role";
import { preload, Screen } from "./views/roles";
import { SHAPE } from "./copy/privacy";
import { TrayProvider } from "./views/Tray";
import { Mark } from "./Mark";

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
    rememberRole(r);
  };

  /* Fetch a role's code on the press rather than on the release, so the
     download overlaps the time it takes to let go of the button. */
  const warm = (r: Role) => () => {
    preload(r).catch(() => undefined);
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
            <button onClick={() => choose("customer")} onPointerDown={warm("customer")}>
              <b>Order</b>
              <span>Get something delivered</span>
            </button>
            <button onClick={() => choose("driver")} onPointerDown={warm("driver")}>
              <b>Drive</b>
              <span>Deliver orders for a fare</span>
            </button>
            <button onClick={() => choose("venue")} onPointerDown={warm("venue")}>
              <b>Sell</b>
              <span>Take orders at your venue</span>
            </button>
            {/* Not a fourth role: it's the arbiter's queue, and it's read-only
                unless this device holds the arbiter's key. Meant for Desktop. */}
            <button
              className="link"
              onClick={() => choose("ops")}
              onPointerDown={warm("ops")}
            >
              Operations console
            </button>
            {/* Not a role either: four measurements that need a real phone,
                which is why they have sat in the backlog (probe.ts). */}
            <button
              className="link"
              onClick={() => choose("probe")}
              onPointerDown={warm("probe")}
            >
              Check this phone
            </button>
            {/* Said once, on the only screen nobody is mid-task on. Every
                screen after this says its own share of it (copy/privacy.ts). */}
            <p className="muted">{SHAPE}</p>
          </section>
        )}

        {role && (
          /* The screen arrives as its own download (views/roles.ts). For a
             device that already knows its role the splash has usually
             finished fetching it before React gets here, so this fallback is
             mostly for a role chosen by hand, a few hundred milliseconds. */
          <Suspense fallback={<p className="muted">Opening…</p>}>
            {(() => {
              const Role = Screen[role];
              return <Role />;
            })()}
          </Suspense>
        )}
      </main>
    </TrayProvider>
  );
}
