import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { resolveFromRouter } from "./contracts";
import { inHost } from "./host";
import { savedRole } from "./role";
import { preload } from "./views/roles";
import "./styles.css";

/**
 * The splash's own API, defined inline in index.html so it exists long before
 * this module does. Absent only in tests and if the document was replaced.
 */
declare global {
  interface Window {
    __porterage?: {
      step: (label: string, pct: number) => void;
      done: () => void;
    };
  }
}
const splash = {
  step: (label: string, pct: number) => window.__porterage?.step(label, pct),
  done: () => window.__porterage?.done(),
};

/** What to call each role while its screen is being fetched. */
const WHAT: Record<string, string> = {
  customer: "your orders",
  driver: "your work",
  venue: "your counter",
  ops: "the operations console",
  probe: "the phone checks",
};

async function start() {
  // Reaching this line means the bundle downloaded, parsed and ran — the long
  // part of a cold load, and the only milestone the splash cannot report for
  // itself.
  splash.step("Starting up", 30);

  // Both of these are network waits and neither needs the other, so they run
  // together; the labels still describe what is actually being waited on.
  // `inHost` memoises, so App's own call costs nothing.
  const host = inHost();
  const addresses = resolveFromRouter();

  splash.step("Looking for your Polkadot account", 55);
  await host;

  // Where the contracts live is settled once, before anything reads one, so
  // the whole session agrees on the answer. An address that changed under a
  // running app would be worse than a stale one: two screens would be talking
  // to two different deployments.
  splash.step("Checking the contracts", 75);
  const moved = await addresses;
  const names = Object.keys(moved);
  if (names.length) console.info(`following the router for: ${names.join(", ")}`);

  // Each role's screen is its own download (views/roles.ts). A device that has
  // been here before already knows which one it needs, so it is fetched now,
  // behind the splash, rather than after React mounts and shows a fallback.
  const role = savedRole();
  if (role) {
    splash.step(`Opening ${WHAT[role]}`, 92);
    await preload(role).catch(() => undefined);
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );

  // After the browser has actually painted the first frame, not merely after
  // render() returned — otherwise the splash clears onto a blank screen and
  // the flicker it exists to prevent happens anyway.
  requestAnimationFrame(() => requestAnimationFrame(() => splash.done()));
}

// A failure here must not leave the splash spinning forever with no
// explanation: the app is more useful half-started than not started.
start().catch((e) => {
  console.error(e);
  splash.done();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
});
