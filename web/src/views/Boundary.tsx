// Somewhere for a failure to stop.
//
// React unmounts the whole tree when a render throws and nothing catches it.
// This app had no boundary anywhere, so a single panel failing took the entire
// screen with it — no tabs, no way back, nothing to read. The driver's
// Earnings tab and the venue's Takings tab both went that way, and from the
// outside it looks like the app is broken rather than one part of it.
//
// A boundary is the only thing that catches it. `Suspense` does not: a lazy
// `import()` that REJECTS — a chunk that failed to arrive, which is an
// ordinary thing over IPFS on a phone with a bad minute — is an error, not a
// suspension, and it goes straight past the fallback.
//
// So the error is shown rather than swallowed. Not because anyone wants to
// read a stack trace, but because the alternative is a blank screen that says
// nothing at all, and someone has to be able to tell us what happened. The
// retry re-mounts the subtree, which is enough on its own when the cause was a
// chunk that did not arrive.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** What failed, in the person's terms: "Earnings", "the backup panel". */
  label?: string;
}

interface State {
  error: Error | null;
}

export class Boundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The device's own console is the only log there is.
    console.error(`${this.props.label ?? "a screen"} failed`, error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-panel">
        <h3>{this.props.label ?? "This part"} didn&rsquo;t open</h3>
        <p className="muted">
          The rest of the app is still working. If it keeps happening, this is
          the part to report:
        </p>
        <p className="error">{error.message || String(error)}</p>
        <div className="actions">
          <button onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}
