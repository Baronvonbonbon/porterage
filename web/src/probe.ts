// Measuring this phone (docs/IMPROVEMENTS.md, "Needs a phone before it can be
// built honestly").
//
// Four questions have been sitting in the backlog because nothing in a test can
// answer them: whether `navigateTo` hands a `geo:` URI to the OS, whether a
// Bulletin write costs a tap every time, whether the camera and the QR scanner
// work in the WebView at all, and whether a notification arrives when the app
// is in the background. Each one decides how a feature should be built, and
// each has been guessed at in a comment somewhere.
//
// The guessing is the problem. A comment that says "unmeasured" is honest once;
// after that it is a thing everyone routes around. So this module turns the
// four questions into four runs of a couple of minutes, and writes down what
// the phone actually did.
//
// THREE THINGS MAKE THIS DIFFERENT FROM A NORMAL SCREEN:
//
//  1. **A probe can destroy the page that started it.** `navigateTo` with an
//     `https` URL navigates the WebView (sonde measured it reloading its own
//     page), and nobody knows yet what it does with `geo:`. If it navigates,
//     the run is gone along with any state in React. So a probe writes "I am
//     about to do X" to localStorage BEFORE it does X, and the screen asks
//     about any unfinished probe when it next loads. Surviving the thing being
//     measured is the whole trick.
//  2. **The interesting part is often not visible to code.** The app cannot
//     see an approval prompt, and it cannot see a notification land on a
//     lock screen. So a probe pairs what it CAN measure (an outcome, a
//     duration) with a plain question for the person holding the phone. An
//     answer they gave is evidence; an answer inferred from a resolved promise
//     is not, and the two are kept apart in the record.
//  3. **The result is meant to leave the phone.** It ends as text to copy into
//     the repo, because a measurement nobody wrote down has to be taken again.
//
// The record holds outcomes and timings only — no keys, no addresses, no order
// ids, nothing about the person. It is meant to be pasted into a public repo.

const KEY = "porterage.probe.v1";

export type ProbeId = "geo" | "bulletin" | "camera" | "notification";

export interface Result {
  id: ProbeId;
  /** What the code saw. Objective, and filled in even when the person doesn't answer. */
  measured: string;
  /** What the person saw. The part no promise can report. */
  answered?: string;
  /** Milliseconds, where a duration means something. */
  ms?: number;
  /** ISO day, so an old measurement can be told from a fresh one. */
  on: string;
  /** Set while a probe is in flight, so a probe that kills the page is noticed. */
  pending?: boolean;
}

export type Book = Partial<Record<ProbeId, Result>>;

export function readBook(): Book {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Book;
  } catch {
    return {};
  }
}

function write(book: Book): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(book));
  } catch {
    // A probe that can't write its own result is still worth running; the
    // person can read it off the screen.
  }
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Note that a probe is about to do something that may take the page with it.
 * Called before the risky call, never after — the point is to leave a mark
 * that outlives the process.
 */
export function beginning(id: ProbeId, measured: string): void {
  write({ ...readBook(), [id]: { id, measured, on: today(), pending: true } });
}

export function record(id: ProbeId, measured: string, ms?: number): Result {
  const result: Result = { id, measured, on: today(), ...(ms ? { ms } : {}) };
  write({ ...readBook(), [id]: result });
  return result;
}

/** Attach what the person saw to whatever the code measured. */
export function answer(id: ProbeId, answered: string): void {
  const book = readBook();
  const had = book[id] ?? { id, measured: "not run", on: today() };
  write({ ...book, [id]: { ...had, answered, pending: false } });
}

export function forget(id: ProbeId): void {
  const book = readBook();
  delete book[id];
  write(book);
}

// ── the questions, as they are asked in docs/IMPROVEMENTS.md ────────────────

export interface Question {
  id: ProbeId;
  /** The backlog's question, in its own words. */
  asks: string;
  /** What the person should expect to happen, so a surprise is recognisable. */
  expect: string;
  /** What the answer decides. A probe whose answer changes nothing isn't worth a tap. */
  decides: string;
  /** The answers offered. Free text is allowed too, but these are the useful ones. */
  choices: string[];
}

export const QUESTIONS: Question[] = [
  {
    id: "geo",
    asks: "Does navigateTo open a map app from a geo: URI?",
    expect:
      "A map app opens on a pin, and Porterage is still here when you come back.",
    decides:
      "Whether 'directions' is one tap or a menu of worse options. If the app " +
      "is replaced instead, an order in progress would be lost — so that " +
      "answer removes the button.",
    choices: [
      "A map app opened, Porterage still here",
      "Nothing happened",
      "Porterage was replaced by something else",
    ],
  },
  {
    id: "bulletin",
    asks: "Does a Bulletin write cost a tap each time, or only the first?",
    expect: "Two writes run back to back. Count the approval prompts.",
    decides:
      "How freely the thread archive writes. Once, and a long conversation " +
      "can archive whenever it likes; every time, and it must batch.",
    choices: ["No prompts", "One prompt", "Two prompts (one each)"],
  },
  {
    id: "camera",
    asks: "Does the camera work in the WebView, and can it read a QR code?",
    expect:
      "The scanner opens and reads the code shown above it — this phone " +
      "scanning its own screen is a real handoff, minus the second phone. " +
      "Pasting it instead answers a different question: it proves the code " +
      "encodes and decodes, and says nothing about the camera.",
    decides:
      "Whether the pickup and dropoff handoffs work at all on a phone. If not, " +
      "the pasted-code fallback becomes the main path, not the fallback.",
    choices: [
      "Scanned it",
      "Camera opened but read nothing",
      "No camera at all",
    ],
  },
  {
    id: "notification",
    asks: "Does a host notification arrive when the app is backgrounded?",
    expect:
      "Put Porterage in the background now. A notification should arrive in " +
      "about 30 seconds.",
    decides:
      "Whether anyone hears about a bid while they're doing something else. " +
      "If nothing arrives, the app has to be open to be useful, and the " +
      "notification code is a courtesy that never fires.",
    choices: [
      "It arrived",
      "Nothing arrived",
      "It arrived, but only on return",
    ],
  },
];

/**
 * The record as text to paste into the repo. Deliberately flat: one line per
 * question, the phone's answer and the person's, because the destination is a
 * markdown table in docs, not a parser.
 */
export function asReport(book: Book): string {
  const lines = QUESTIONS.map((q) => {
    const r = book[q.id];
    if (!r) return `- ${q.asks}\n  not run`;
    const bits = [
      `measured: ${r.measured}`,
      r.ms !== undefined ? `${r.ms} ms` : null,
      r.answered ? `saw: ${r.answered}` : "no answer from the person",
      r.pending ? "PENDING — the probe never came back" : null,
    ].filter(Boolean);
    return `- ${q.asks}\n  ${bits.join(" · ")} (${r.on})`;
  });
  return `Porterage phone probes\n\n${lines.join("\n")}\n`;
}
