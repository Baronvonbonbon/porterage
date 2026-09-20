// The tokens Porterage accepts (docs/PLAN.md §5.1).
//
// Every one needs a PAS pair on Asset Hub's asset-conversion DEX, because PAS is
// the shielded pool's asset: a token is swapped to PAS before shielding, and
// back afterwards. All three below have a live pool on Paseo (checked
// 2026-09-20). Hollar and dotUSD have no asset there yet.
//
// The swap is deliberately public. It happens on the user's own account, on the
// funding side of the anonymity boundary — the same kind of visible event as a
// withdrawal from an exchange — and says nothing about any order.

export interface Token {
  /** Asset Hub asset id. */
  id: number;
  symbol: string;
  decimals: number;
  /** How the ERC-20 view of this asset is addressed from the EVM side. */
  precompile: string;
  note?: string;
}

export const PAS_DECIMALS = 10; // Substrate side; the EVM sees 18

export const TOKENS: readonly Token[] = [
  { id: 1337, symbol: "USDC", decimals: 6, precompile: "0x0000053900000000000000000000000001200000" },
  { id: 1984, symbol: "USDT", decimals: 6, precompile: "0x000007c000000000000000000000000001200000" },
  {
    id: 50000413,
    symbol: "pUSD",
    decimals: 6,
    precompile: "0x02faf21d00000000000000000000000001200000",
    note: "transfer restrictions unproven for contracts (FARE spike S4)",
  },
];

export const tokenOf = (id: number): Token | undefined => TOKENS.find((t) => t.id === id);

/** `amount` in an asset's smallest units, as a human string. */
export function formatUnits(amount: bigint, decimals: number, places = 2): string {
  const unit = 10n ** BigInt(decimals);
  const whole = amount / unit;
  const frac = (amount % unit).toString().padStart(decimals, "0").slice(0, places);
  return places ? `${whole}.${frac}` : `${whole}`;
}

/** A human string in an asset's smallest units; null when it isn't a number. */
export function parseUnits(s: string, decimals: number): bigint | null {
  const m = s.trim().match(/^(\d*)(?:\.(\d*))?$/);
  if (!m || (!m[1] && !m[2])) return null;
  const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  const v = BigInt((m[1] || "0") + frac);
  return v > 0n ? v : null;
}
