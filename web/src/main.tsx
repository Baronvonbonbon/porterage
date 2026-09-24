import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { resolveFromRouter } from "./contracts";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
const show = () =>
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  );

// Where the contracts are is settled once, before anything reads one, so the
// whole session agrees on the answer. An address that changed under a running
// app would be worse than a stale one: two screens would be talking to two
// different deployments.
//
// It never blocks for long and it never fails the app — `resolveFromRouter`
// gives up on its own timeout and leaves the built-in addresses in place.
resolveFromRouter()
  .then((moved) => {
    const names = Object.keys(moved);
    if (names.length) console.info(`following the router for: ${names.join(", ")}`);
  })
  .catch(() => undefined)
  .finally(show);
