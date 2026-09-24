// @vitest-environment happy-dom
//
// The boundary is the thing that decides whether one panel failing is a
// nuisance or the end of the session, so it gets its own test rather than
// being assumed to work. The case that matters is the second one: a lazy
// import that REJECTS goes past `Suspense`, and before this existed it took
// the whole app with it.

import { describe, expect, it, vi } from "vitest";
import { lazy, Suspense } from "react";
import { render, screen } from "@testing-library/react";
import { Boundary } from "./Boundary";

/** React logs caught errors itself; the test does not need to see them. */
const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

function Throws(): never {
  throw new Error("nextNoteIndex is not a function");
}

describe("Boundary", () => {
  it("shows what failed instead of unmounting everything", () => {
    quiet();
    render(
      <div>
        <p>the rest of the screen</p>
        <Boundary label="Earnings">
          <Throws />
        </Boundary>
      </div>
    );
    // The sibling survives: that is the whole point.
    expect(screen.getByText("the rest of the screen")).toBeTruthy();
    expect(screen.getByText(/Earnings/)).toBeTruthy();
    // The message is readable, so someone can say what went wrong.
    expect(screen.getByText("nextNoteIndex is not a function")).toBeTruthy();
  });

  it("catches a lazy chunk that never arrives, which Suspense does not", async () => {
    quiet();
    const Missing = lazy(() =>
      Promise.reject(new Error("Failed to fetch dynamically imported module"))
    );
    render(
      <Boundary label="The backup panel">
        <Suspense fallback={<p>loading</p>}>
          <Missing />
        </Suspense>
      </Boundary>
    );
    await screen.findByText(/didn’t open/);
    expect(screen.getByText(/dynamically imported module/)).toBeTruthy();
  });

  it("stays out of the way when nothing is wrong", () => {
    render(
      <Boundary label="Earnings">
        <p>paid to you</p>
      </Boundary>
    );
    expect(screen.getByText("paid to you")).toBeTruthy();
  });
});
