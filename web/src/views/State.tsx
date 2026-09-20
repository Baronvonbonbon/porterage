// Waiting, and having nothing to show.
//
// Several screens rendered nothing at all while they fetched, which on a slow
// phone is indistinguishable from broken — the commonest way a working app
// looks broken. These are the two lines that fix that, kept together so they
// say it the same way everywhere.

export function Waiting({ what }: { what: string }) {
  return (
    <p className="waiting" role="status">
      {what}
    </p>
  );
}

/**
 * Nothing to show, and what to do about it. An empty screen that only says
 * "none" leaves someone wondering whether to wait or to act.
 */
export function Empty({ what, next }: { what: string; next?: string }) {
  return (
    <p className="muted">
      {what}
      {next ? ` ${next}` : ""}
    </p>
  );
}
