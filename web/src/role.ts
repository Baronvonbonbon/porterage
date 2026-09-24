// Which role this device is acting as, and where that is remembered.
//
// Its own module so that `main.tsx` can read the saved role before the app
// mounts — it uses it to start fetching that role's code while the splash is
// still up — without importing App.tsx and dragging the whole tree in with it.

export type Role = "customer" | "driver" | "venue" | "ops" | "probe";

const ROLE_KEY = "porterage.role";

const ROLES: Role[] = ["customer", "driver", "venue", "ops", "probe"];

export function savedRole(): Role | null {
  try {
    const r = localStorage.getItem(ROLE_KEY);
    // "probe" belongs here for a reason: if a probe navigates the WebView
    // away, the app restarts, and it has to come back to the screen that
    // knows a probe was in flight (probe.ts).
    return ROLES.includes(r as Role) ? (r as Role) : null;
  } catch {
    return null;
  }
}

export function rememberRole(r: Role | null) {
  try {
    if (r) localStorage.setItem(ROLE_KEY, r);
    else localStorage.removeItem(ROLE_KEY);
  } catch {
    /* private mode: the choice just isn't remembered */
  }
}
