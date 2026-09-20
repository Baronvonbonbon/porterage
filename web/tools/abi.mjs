// Copy each contract's ABI out of the Hardhat build into src/abi/, so the app
// always calls the contracts as compiled. Run `npx hardhat compile` at the repo
// root first.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ART = join(HERE, "..", "..", "artifacts", "contracts");
const OUT = join(HERE, "..", "src", "abi");
const CONTRACTS = ["PorterDrivers", "PorterVenues", "PorterOrders", "PorterSettlement", "PorterVault", "PorterDisputes", "PorterRatings", "PorterPauseRegistry"];

if (!existsSync(ART)) {
  console.error("No contract build found. Run `npx hardhat compile` in the repo root first.");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
for (const name of CONTRACTS) {
  const { abi } = JSON.parse(readFileSync(join(ART, `${name}.sol`, `${name}.json`), "utf8"));
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(abi, null, 1) + "\n");
}
console.log(`wrote ${CONTRACTS.length} ABIs to src/abi/`);
