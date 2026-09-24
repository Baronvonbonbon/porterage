// The message tray.
//
// Conversations used to be rendered wherever they happened to belong: two
// stacked inside the customer's order screen, one behind a "messages" toggle on
// a job card, one behind another on a venue's counter row. Three consequences,
// all of them bad. A thread only existed while you were looking at the screen
// that owned it, so a reply arriving while you were anywhere else was silently
// missed. The toggles said "messages" in the same small text as everything
// else, so nobody found them. And a long thread pushed the actual controls of
// the screen off the bottom.
//
// So a screen no longer renders a thread. It OFFERS one — "there is a
// conversation here, with this key, about this order" — and the tray owns it
// from there: docked at the bottom of every screen, counting what arrived while
// it was shut, opening over the top when asked and getting out of the way
// again.
//
// The threads themselves stay mounted while they are offered, closed or not.
// That is the point: a mounted thread is a thread that is listening, and the
// unread count is only honest if nothing was missed to begin with. Screens are
// expected to offer conversations only for orders that are actually live, which
// is what bounds how many of those there are.

import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Reader } from "../order/seal";

// Fetched when there is actually a conversation to hold.
//
// The tray is mounted by App on every screen, so importing this directly put
// the whole thread stack in the startup chunk — and through it `order/chat` →
// `shield/notes` → `shield/pool`, which is 609 kB of Poseidon that the role
// chooser has no use for. A conversation can only be offered from inside a
// role screen, and those are downloads of their own already.
const Thread = lazy(() =>
  import("./Thread").then((m) => ({ default: m.Thread }))
);

export interface Conversation {
  /** Stable and unique across the app: one per (order, counterpart). */
  id: string;
  /** This device's key for the thread. */
  mine: Reader;
  /** The other party's public key. */
  theirs: string;
  orderId: bigint;
  /** Shown on the tab and in the tray's summary line. */
  title: string;
}

interface Tray {
  offer: (c: Conversation) => void;
  withdraw: (id: string) => void;
}

const TrayContext = createContext<Tray | null>(null);

/**
 * Offer a conversation for as long as this component is mounted and `conv` is
 * non-null. Safe to call unconditionally — pass null when there is nothing to
 * offer, which is what a hook cannot do by being skipped.
 */
export function useConversation(conv: Conversation | null) {
  const tray = useContext(TrayContext);
  // Held in a ref so that a screen re-rendering with a fresh object literal
  // does not withdraw and re-offer the same conversation on every keystroke.
  const latest = useRef(conv);
  latest.current = conv;

  const id = conv?.id ?? null;
  const theirs = conv?.theirs ?? null;
  const title = conv?.title ?? null;

  useEffect(() => {
    if (!tray || !id || !latest.current) return;
    tray.offer(latest.current);
    return () => tray.withdraw(id);
  }, [tray, id, theirs, title]);
}

/**
 * Offer a conversation from inside a list, where a hook cannot go.
 *
 * Jobs and the venue counter both map over orders, and a conversation belongs
 * to an order rather than to the screen — so there is no fixed number of hooks
 * to write. Renders nothing.
 */
export function Offer({ conv }: { conv: Conversation | null }) {
  useConversation(conv);
  return null;
}

export function TrayProvider({ children }: { children: ReactNode }) {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  /** How many messages each thread had when it was last on screen. */
  const [seen, setSeen] = useState<Record<string, number>>({});
  const [counts, setCounts] = useState<Record<string, number>>({});

  const offer = useCallback((c: Conversation) => {
    setConvs((all) =>
      all.some((x) => x.id === c.id) ? all : [...all, c]
    );
  }, []);

  const withdraw = useCallback((id: string) => {
    setConvs((all) => all.filter((x) => x.id !== id));
  }, []);

  const tray = useMemo(() => ({ offer, withdraw }), [offer, withdraw]);

  // Keep a sensible tab selected as conversations come and go.
  useEffect(() => {
    if (!convs.length) {
      setOpen(false);
      setActive(null);
    } else if (!active || !convs.some((c) => c.id === active)) {
      setActive(convs[0].id);
    }
  }, [convs, active]);

  // Whatever is on screen has been read. Tracked as a count rather than a
  // flag so a message arriving while the sheet is open does not get marked
  // unread the moment it is closed.
  const showing = open ? active : null;
  useEffect(() => {
    if (!showing) return;
    setSeen((s) => ({ ...s, [showing]: counts[showing] ?? 0 }));
  }, [showing, counts]);

  const unreadOf = (id: string) =>
    Math.max(0, (counts[id] ?? 0) - (seen[id] ?? 0));
  const unread = convs.reduce((n, c) => n + unreadOf(c.id), 0);

  return (
    <TrayContext.Provider value={tray}>
      {children}

      {convs.length > 0 && (
        <>
          {/* The docked bar is fixed, so the page needs somewhere to end. */}
          <div className="tray-spacer" />

          <div className={`tray${open ? " open" : ""}`}>
            <button
              className="tray-handle"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
            >
              <span className="tray-title">
                Messages
                {unread > 0 && (
                  <span className="badge" aria-label={`${unread} unread`}>
                    {unread}
                  </span>
                )}
              </span>
              <span className="muted tray-hint">
                {open
                  ? "close"
                  : convs.length === 1
                    ? convs[0].title
                    : `${convs.length} conversations`}
              </span>
              <span className="tray-chevron" aria-hidden="true">
                {open ? "⌄" : "⌃"}
              </span>
            </button>

            {/* Mounted whether or not the sheet is open: a thread that is not
                mounted is not listening, and an unread count built on missed
                messages would be worse than none. `hidden` rather than
                unmounting for the same reason. */}
            <div className="tray-body" hidden={!open}>
              {convs.length > 1 && (
                <nav className="tabs" role="tablist">
                  {convs.map((c) => (
                    <button
                      key={c.id}
                      role="tab"
                      aria-selected={c.id === active}
                      onClick={() => setActive(c.id)}
                    >
                      {c.title}
                      {unreadOf(c.id) > 0 && (
                        <span className="badge">{unreadOf(c.id)}</span>
                      )}
                    </button>
                  ))}
                </nav>
              )}
              {convs.map((c) => (
                <div key={c.id} hidden={c.id !== active}>
                  <Suspense fallback={<p className="muted">Opening…</p>}>
                    <Thread
                      mine={c.mine}
                      theirs={c.theirs}
                      orderId={c.orderId}
                      title={c.title}
                      onCount={(n) =>
                        setCounts((all) =>
                          all[c.id] === n ? all : { ...all, [c.id]: n }
                        )
                      }
                    />
                  </Suspense>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </TrayContext.Provider>
  );
}
