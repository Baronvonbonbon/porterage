// The stop button, and what is deployed.
//
// PorterPauseRegistry and PorterGovernanceRouter have existed since the first
// deploy and have never had a screen. Stopping anything meant a script, a
// terminal and the deploy key — which is exactly what nobody has to hand at the
// moment they need to stop something.
//
// The authority model is worth reading before using this. A GUARDIAN can pause
// any category, immediately and alone. Only the OWNER can unpause. That
// asymmetry is deliberate and it is the right way round: stopping a runaway
// should be fast and available to several people, restarting should not. It
// also means pausing is close to irreversible for anyone who is not the owner,
// so the button asks first.
//
// The router half is read-only here on purpose. `upgradeContract` repoints a
// name at new code for every client at once; that is not a thing to do from a
// phone between other taps, and it belongs with the deploy script that can also
// verify the new address first.

import { useCallback, useEffect, useState } from "react";
import { Contract, encodeBytes32String, type Wallet } from "ethers";
import { addressOf, deployed, ethProvider, writable } from "../contracts";
import DEPLOYED from "../deployed.json";
import { errorText, short } from "../format";

/** Matches PorterPauseRegistry's constants. */
const CATEGORIES: { id: number; name: string; what: string }[] = [
  { id: 0, name: "Orders", what: "Placing, bidding and accepting. Deliveries in flight still settle." },
  { id: 1, name: "Settlement", what: "Pickup and dropoff confirmations. A delivery cannot complete." },
  { id: 2, name: "Disputes", what: "Opening and ruling on cases." },
  { id: 3, name: "Registry", what: "Registering drivers and venues." },
];

const PAUSE_ABI = [
  "function paused(uint8) view returns (bool)",
  "function isGuardian(address) view returns (bool)",
  "function owner() view returns (address)",
  "function pause(uint8)",
  "function unpause(uint8)",
];

const ROUTER_ABI = [
  "function currentAddrOf(bytes32) view returns (address)",
  "function owner() view returns (address)",
];

const NAMES = [
  "pauseRegistry",
  "vault",
  "drivers",
  "venues",
  "orders",
  "settlement",
  "disputes",
  "ratings",
];

export function Controls({ signer }: { signer: Wallet | null }) {
  const [shut, setShut] = useState<Set<number>>(new Set());
  const [guardian, setGuardian] = useState(false);
  const [owner, setOwner] = useState<string | null>(null);
  const [registry, setRegistry] = useState<[string, string][]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    if (!deployed()) return;
    try {
      const pause = new Contract(addressOf("pauseRegistry"), PAUSE_ABI, ethProvider());
      const open = new Set<number>();
      for (const c of CATEGORIES) if (await pause.paused(c.id)) open.add(c.id);
      setShut(open);
      setOwner(await pause.owner());
      if (signer) setGuardian(await pause.isGuardian(signer.address));

      // `router` has no ABI file, so it is not a ContractName; its address
      // comes straight out of the address book.
      const routerAt = (DEPLOYED as { router?: string }).router;
      if (!routerAt) return;
      const router = new Contract(routerAt, ROUTER_ABI, ethProvider());
      const rows: [string, string][] = [];
      for (const n of NAMES) {
        rows.push([n, await router.currentAddrOf(encodeBytes32String(n))]);
      }
      setRegistry(rows);
    } catch (e) {
      setError(errorText(e));
    }
  }, [signer]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const isOwner =
    !!signer && !!owner && signer.address.toLowerCase() === owner.toLowerCase();

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
      setAsking(null);
    }
  }

  const contract = () =>
    new Contract(addressOf("pauseRegistry"), PAUSE_ABI, writable(signer!));

  if (!deployed())
    return (
      <div>
        <h3>Controls</h3>
        <p className="muted">Nothing is deployed on this network.</p>
      </div>
    );

  return (
    <div>
      <h3>Stop things</h3>
      <p className="muted">
        Pausing takes effect at once and for everyone. A guardian can pause;
        only the owner can start it again — so if you're not the owner, treat
        this as one-way.
      </p>
      {!signer ? (
        <p className="warn">No key on this device, so these are read-only.</p>
      ) : !guardian && !isOwner ? (
        <p className="warn">
          {short(signer.address)} is neither the owner nor a guardian, so these
          will be refused.
        </p>
      ) : (
        <p className="ok">
          {short(signer.address)} is {isOwner ? "the owner" : "a guardian"}.
        </p>
      )}

      <ul className="rows">
        {CATEGORIES.map((c) => (
          <li key={c.id}>
            <div>
              <b>{c.name}</b>{" "}
              {shut.has(c.id) ? (
                <span className="error">paused</span>
              ) : (
                <span className="ok">running</span>
              )}
            </div>
            <p className="muted">{c.what}</p>
            {shut.has(c.id) ? (
              <div className="actions">
                <button
                  disabled={!!busy || !isOwner}
                  onClick={() =>
                    run(`Restarting ${c.name}`, () =>
                      contract().unpause(c.id).then((t: { wait: () => unknown }) => t.wait())
                    )
                  }
                >
                  {isOwner ? `Start ${c.name}` : "Only the owner can start it"}
                </button>
              </div>
            ) : asking === c.id ? (
              <div className="actions">
                <button
                  className="primary"
                  disabled={!!busy}
                  onClick={() =>
                    run(`Pausing ${c.name}`, () =>
                      contract().pause(c.id).then((t: { wait: () => unknown }) => t.wait())
                    )
                  }
                >
                  Yes, pause {c.name}
                </button>
                <button disabled={!!busy} onClick={() => setAsking(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="actions">
                <button
                  disabled={!!busy || (!guardian && !isOwner)}
                  onClick={() => setAsking(c.id)}
                >
                  Pause {c.name}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <h3>What's deployed</h3>
      <p className="muted">
        What the governance router currently points each name at. Changing one
        is a deploy-script job, not a phone job — it repoints every client at
        once.
      </p>
      <dl>
        {registry.map(([name, addr]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd title={addr}>{short(addr)}</dd>
          </div>
        ))}
      </dl>

      {busy && <p className="muted">{busy}…</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
