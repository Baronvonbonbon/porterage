// @vitest-environment happy-dom
//
// The money panels, actually rendered.
//
// The suite had 232 tests and not one of them mounted a component, which is
// how a screen that blanks the whole app shipped twice without anything going
// red. The driver's Earnings tab and the venue's Takings tab both crashed
// app-wide after a publish, and neither a typecheck nor a logic test could
// have seen it: the failure is a throw during render, and React with no error
// boundary unmounts the entire tree when that happens.
//
// So these mount the three panels those two tabs share — Earnings, Books and
// Funds — with the chain and the device's storage stubbed. What is being
// tested is not what they say. It is that they render at all, in the states a
// real device is in: nothing loaded yet, nothing to show, and something to
// show.
//
// The empty state is the one that matters. Every one of these panels is opened
// for the first time by someone who has never earned anything, and that is
// exactly the state that a `[0]` or a `BigInt(undefined)` walks straight into.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// ── the chain ───────────────────────────────────────────────────────────────
const vault = { balanceOf: vi.fn(async () => 0n) };
vi.mock("../contracts", () => ({
  read: () => vault,
  readAt: () => vault,
  addressOf: () => "0x0000000000000000000000000000000000000001",
  ethProvider: () => ({}),
  writable: () => ({}),
  ABI: { vault: { fragments: [] } },
}));
vi.mock("../shield/payout", () => ({
  buckets: async () => [10n ** 18n, 5n * 10n ** 18n],
  bucketFor: (balance: bigint, all: bigint[]) =>
    [...all].reverse().find((b) => b <= balance) ?? null,
}));

// ── what this device has written down ───────────────────────────────────────
const payouts = vi.fn(async () => [] as unknown[]);
const notes = vi.fn(async () => [] as unknown[]);
vi.mock("../shield/notes", () => ({
  allPayouts: () => payouts(),
  allNotes: () => notes(),
}));

const days = vi.fn(async (_kind: string) => [] as string[]);
const entries = vi.fn(async (_kind: string, _day: string) => [] as unknown[]);
vi.mock("../books/ledger", () => ({
  days: (k: string) => days(k),
  closedDays: async () => [],
  forgetKind: vi.fn(),
  entriesOfDay: (_k: string, d: string) => entries(_k, d),
  totalsOf: (rows: unknown[]) => ({
    goods: 0n,
    tax: 0n,
    total: 0n,
    net: 0n,
    count: rows.length,
  }),
}));

// ── the host chain, which only exists inside the Polkadot app ───────────────
vi.mock("../hostchain", () => ({
  hostAccount: async () => null,
  freeBalance: async () => 0n,
}));
vi.mock("../shield/cashout", () => ({
  cashOut: vi.fn(),
  cashOutBalances: async () => [],
  sendOnward: vi.fn(),
  sendableOf: () => 0n,
}));
vi.mock("../shield/plan", () => ({
  describePlan: () => "",
  maxWithdrawable: () => 0n,
  planWithdrawal: () => null,
}));
vi.mock("../shield/deposit", () => ({ planTopUp: () => null, topUp: vi.fn() }));
vi.mock("../shield/payoutFlow", () => ({
  releaseEarnings: vi.fn(),
  shieldEarnings: vi.fn(),
}));
vi.mock("../books/backup", () => ({ closeDay: vi.fn() }));

import { Earnings } from "./Earnings";
import { Books } from "./Books";
import { Funds } from "./Funds";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Let the effects settle: these panels all load in a useEffect. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("Earnings", () => {
  it("renders for someone who has never been paid", async () => {
    render(<Earnings account="0x0000000000000000000000000000000000000002" />);
    await settle();
    expect(screen.getByText("Earnings")).toBeTruthy();
  });

  it("renders with a balance and notes waiting", async () => {
    vault.balanceOf.mockResolvedValueOnce(7n * 10n ** 18n);
    payouts.mockResolvedValueOnce([
      { n: 1, bucket: (10n ** 18n).toString(), insertedAt: 100 },
    ]);
    render(<Earnings account="0x0000000000000000000000000000000000000002" />);
    await settle();
    expect(screen.getByText("Earnings")).toBeTruthy();
  });
});

describe("Books", () => {
  it("renders with no days recorded", async () => {
    render(<Books kind="earning" backup />);
    await settle();
    expect(screen.getByText(/Nothing recorded yet/)).toBeTruthy();
  });

  it("renders a day, with the backup offered", async () => {
    days.mockResolvedValue(["2026-09-24"]);
    render(<Books kind="sale" backup />);
    await settle();
    expect(screen.getByText("Close the day")).toBeTruthy();
  });
});

describe("Funds", () => {
  it("renders outside the Polkadot app, with no host account", async () => {
    render(<Funds />);
    await settle();
  });
});
