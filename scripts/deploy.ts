// deploy.ts — Porterage contract deployment + wiring (ported from FARE).
//
// Paseo eth-rpc workaround (inherited from the DATUM alpha-core deploy
// experience): getTransactionReceipt can return null for confirmed txs, so
// we confirm by nonce polling and derive deploy addresses with
// getCreateAddress(sender, nonce), then verify with getCode().
//
// Re-run safe: reads deployed-addresses.<network>.json and skips contracts
// that already have code; wiring calls are idempotent.
//
// Usage:
//   npm run deploy-key     create the deployer key once; print its address and balance
//   npm run deploy         deploy to Paseo Asset Hub (polkadotTestnet)
//   npx hardhat run scripts/deploy.ts --network localhost
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Gas is estimated per transaction everywhere. Paseo's eth-rpc estimates
// correctly now (~1M for the largest deploy, 2026-09-19), and a fixed limit
// is costly there: at a gas price of 1e12 wei, the old 500M cap reserved
// 500 PAS per transaction up front.
const GAS_LIMIT: bigint | undefined = undefined;

// pine-rpc quirk: eth_getCode hangs on Asset Hub today (CAPABILITIES.md), so
// on the pine network we skip code-based verification and rely on nonce
// confirmation + the wiring validation reads (eth_call works fine).
const CAN_GET_CODE = network.name !== "pine";

// `pine` is Paseo reached through a local light client — same chain, same
// canonical address book as polkadotTestnet.
const suffix = ["polkadotTestnet", "pine"].includes(network.name) ? "" : `.${network.name}`;
const ADDR_FILE = path.join(__dirname, "..", `deployed-addresses${suffix}.json`);
const WEB_ADDR_FILE = path.join(__dirname, "..", "web", "src", "deployed.json");

type AddressBook = Record<string, string>;

function loadAddresses(): AddressBook {
  if (fs.existsSync(ADDR_FILE)) return JSON.parse(fs.readFileSync(ADDR_FILE, "utf-8"));
  return {};
}

function saveAddresses(book: AddressBook) {
  fs.writeFileSync(ADDR_FILE, JSON.stringify(book, null, 2) + "\n");
}

async function waitForNonce(provider: any, address: string, targetNonce: number, maxWait = 180) {
  for (let i = 0; i < maxWait; i++) {
    const current = await provider.getTransactionCount(address);
    if (current > targetNonce) return;
    if (i % 10 === 0 && i > 0) console.log(`    ...waiting for confirmation (${i}s)`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for nonce > ${targetNonce}`);
}

async function verifyCode(provider: any, addr: string, maxWait = 60): Promise<boolean> {
  for (let i = 0; i < maxWait; i++) {
    const code = await provider.getCode(addr);
    if (code && code !== "0x") return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account — set DEPLOYER_PRIVATE_KEY in .env");
  const provider = ethers.provider;
  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(await provider.getBalance(deployer.address))}\n`);

  const book = loadAddresses();

  async function deployOrReuse(key: string, contractName: string, args: any[] = []): Promise<string> {
    if (book[key]) {
      if (!CAN_GET_CODE) {
        console.log(`  = ${contractName} reused at ${book[key]} (pine: getCode unavailable, trusting address book)`);
        return book[key];
      }
      const code = await provider.getCode(book[key]);
      if (code && code !== "0x") {
        console.log(`  = ${contractName} reused at ${book[key]}`);
        return book[key];
      }
    }
    const factory = await ethers.getContractFactory(contractName, deployer);
    const nonce = await provider.getTransactionCount(deployer.address);
    const unsigned = await factory.getDeployTransaction(...args);
    await deployer.sendTransaction({ ...unsigned, nonce, gasLimit: GAS_LIMIT });
    await waitForNonce(provider, deployer.address, nonce);
    const addr = ethers.getCreateAddress({ from: deployer.address, nonce });
    if (CAN_GET_CODE) {
      if (!(await verifyCode(provider, addr))) {
        throw new Error(`${contractName}: no code at derived address ${addr}`);
      }
    } else {
      console.log(`    (pine: skipping getCode verification — nonce confirmed)`);
    }
    console.log(`  + ${contractName} deployed at ${addr}`);
    book[key] = addr;
    saveAddresses(book);
    return addr;
  }

  async function send(label: string, txFactory: () => Promise<any>) {
    const nonce = await provider.getTransactionCount(deployer.address);
    await txFactory();
    await waitForNonce(provider, deployer.address, nonce);
    console.log(`  ~ ${label}`);
  }

  // ── 1. Deploy ──────────────────────────────────────────────────────────
  console.log("1. Deploying contracts");
  const router = await deployOrReuse("router", "PorterGovernanceRouter");
  const pause = await deployOrReuse("pauseRegistry", "PorterPauseRegistry");
  const vault = await deployOrReuse("vault", "PorterVault");
  const drivers = await deployOrReuse("drivers", "PorterDrivers", [pause]);
  const venues = await deployOrReuse("venues", "PorterVenues", [pause]);
  const orders = await deployOrReuse("orders", "PorterOrders", [pause]);
  const settlement = await deployOrReuse("settlement", "PorterSettlement", [pause]);
  const disputes = await deployOrReuse("disputes", "PorterDisputes", [pause]);
  const locationVerifier = await deployOrReuse("locationVerifier", "PorterLocationVerifier");
  const ratings = await deployOrReuse("ratings", "PorterRatings");
  const shieldVerifier = await deployOrReuse("shieldVerifier", "PorterShieldVerifier");

  // Stablecoin escrow (C3). Asset Hub USDC is asset 1337, seen from the EVM
  // through its ERC-20 precompile — a REAL asset with a real price and a live
  // PAS pool on asset-conversion. This used to fall back to deploying MockUSDC,
  // an ERC-20 with an open `mint`; that put a token anyone can print into the
  // escrow accounting, and made the relay's profitability guard meaningless for
  // token orders because it values a rebate at a price the mock does not have.
  // MockUSDC is now a TEST-ONLY fixture: local chains get it, live ones never do.
  const REAL_USDC = "0x0000053900000000000000000000000001200000";
  const isLocal = ["localhost", "hardhat"].includes(network.name);
  const stablecoin = process.env.STABLECOIN_ADDRESS
    ?? (isLocal
      ? await deployOrReuse("stablecoin", "MockUSDC")
      : REAL_USDC);
  if (!isLocal && !process.env.STABLECOIN_ADDRESS) {
    console.log(`  = stablecoin: real Asset Hub USDC ${REAL_USDC} (buy some: node scripts/swap-local-dex.mjs)`);
  }

  // ── 2. Wiring ──────────────────────────────────────────────────────────
  console.log("\n2. Wiring");
  const treasury = process.env.TREASURY_ADDRESS ?? deployer.address;
  const ordersC = await ethers.getContractAt("PorterOrders", orders, deployer);
  const settlementC = await ethers.getContractAt("PorterSettlement", settlement, deployer);
  const disputesC = await ethers.getContractAt("PorterDisputes", disputes, deployer);
  const vaultC = await ethers.getContractAt("PorterVault", vault, deployer);
  const driversC = await ethers.getContractAt("PorterDrivers", drivers, deployer);
  const venuesC = await ethers.getContractAt("PorterVenues", venues, deployer);

  // Check EVERY address `configure` sets, not just one of them. This guard used
  // to compare `settlement` alone, which made a single-contract redeploy quietly
  // dangerous: delete `vault` from deployed-addresses.json, re-run, and the new
  // vault deploys while this line sees an unchanged `settlement`, prints
  // "already configured", and leaves orders paying into the DEAD vault. The
  // validation block below would have caught it — after the fact, on a live
  // chain, with a contract already deployed. Cheaper to notice here.
  const wiring: Array<[string, string]> = [
    [await ordersC.vault(), vault],
    [await ordersC.drivers(), drivers],
    [await ordersC.venues(), venues],
    [await ordersC.settlement(), settlement],
    [await ordersC.disputes(), disputes],
    [await ordersC.treasury(), treasury],
  ];
  if (wiring.some(([have, want]) => have !== want)) {
    await send("orders.configure", () =>
      ordersC.configure(vault, drivers, venues, settlement, disputes, treasury, { gasLimit: GAS_LIMIT })
    );
  } else console.log("  = orders already configured");

  // Register the stablecoin as an accepted escrow token (C3).
  if (!(await ordersC.acceptedToken(stablecoin))) {
    await send("orders.setAcceptedToken(stablecoin)", () =>
      ordersC.setAcceptedToken(stablecoin, true, { gasLimit: GAS_LIMIT })
    );
  } else console.log("  = stablecoin already accepted");

  if (
    (await settlementC.orders()) !== orders ||
    (await settlementC.venues()) !== venues
  ) {
    await send("settlement.configure", () =>
      settlementC.configure(orders, venues, { gasLimit: GAS_LIMIT })
    );
  } else console.log("  = settlement already configured");

  // Session keys: settlement accepts a driver's session-key signature (docs/PLAN.md §3.2).
  if ((await settlementC.drivers()) !== drivers) {
    await send("settlement.setDrivers", () => settlementC.setDrivers(drivers, { gasLimit: GAS_LIMIT }));
  } else console.log("  = settlement drivers already wired");

  // ── ZK proximity verifier: set the VK, then wire it into settlement ─────
  const verifierC = await ethers.getContractAt("PorterLocationVerifier", locationVerifier, deployer);
  const VK_CALLDATA = path.join(__dirname, "..", "circuits", "build", "setVK-calldata.json");
  if (!(await verifierC.vkSet())) {
    if (fs.existsSync(VK_CALLDATA)) {
      const vk = JSON.parse(fs.readFileSync(VK_CALLDATA, "utf-8"));
      await send("locationVerifier.setVerifyingKey", () =>
        verifierC.setVerifyingKey(
          vk.alpha1, vk.beta2, vk.gamma2, vk.delta2,
          vk.IC0, vk.IC1, vk.IC2, vk.IC3, vk.IC4, vk.IC5,
          { gasLimit: GAS_LIMIT }
        )
      );
    } else {
      console.log("  ! setVK-calldata.json missing — run `node scripts/setup-zk.mjs` then re-run deploy");
    }
  } else console.log("  = locationVerifier VK already set");

  if ((await settlementC.locationVerifier()) !== locationVerifier) {
    await send("settlement.setLocationVerifier", () =>
      settlementC.setLocationVerifier(locationVerifier, { gasLimit: GAS_LIMIT })
    );
  } else console.log("  = settlement verifier already wired");

  if (
    (await disputesC.orders()) !== orders ||
    (await disputesC.vault()) !== vault ||
    (await disputesC.drivers()) !== drivers ||
    (await disputesC.treasury()) !== treasury
  ) {
    await send("disputes.configure", () =>
      disputesC.configure(orders, vault, drivers, treasury, { gasLimit: GAS_LIMIT })
    );
  } else console.log("  = disputes already configured");

  // An arbiter can only rule if one is set, and evidence can only be sealed to
  // it if its PUBLIC key is known — an address is a hash, and ECDH needs the
  // point. So the key goes into the app's address book, where the app checks it
  // against this address before trusting it (web/src/order/arbiter.ts).
  // On the testnet that arbiter is the deploy key: a single account we hold,
  // and the plainest centralisation left in the design (docs/PLAN.md §6).
  const arbiter = process.env.ARBITER_ADDRESS ?? deployer.address;
  if ((await disputesC.arbiter()) !== arbiter) {
    await send("disputes.setArbiter", () => disputesC.setArbiter(arbiter, { gasLimit: GAS_LIMIT }));
  } else console.log("  = arbiter already set");

  const ratingsC = await ethers.getContractAt("PorterRatings", ratings, deployer);
  if ((await ratingsC.orders()) !== orders) {
    await send("ratings.configure", () => ratingsC.configure(orders, { gasLimit: GAS_LIMIT }));
  } else console.log("  = ratings already configured");

  for (const [who, addr] of [
    ["orders", orders],
    ["disputes", disputes],
  ] as const) {
    if (!(await vaultC.authorized(addr))) {
      await send(`vault.setAuthorized(${who})`, () =>
        vaultC.setAuthorized(addr, true, { gasLimit: GAS_LIMIT })
      );
    }
    if (!(await driversC.authorized(addr))) {
      await send(`drivers.setAuthorized(${who})`, () =>
        driversC.setAuthorized(addr, true, { gasLimit: GAS_LIMIT })
      );
    }
  }
  if (!(await venuesC.authorized(orders))) {
    await send("venues.setAuthorized(orders)", () =>
      venuesC.setAuthorized(orders, true, { gasLimit: GAS_LIMIT })
    );
  }

  // ── Shielded payouts (docs/PLAN.md §5.6) ────────────────────────────────
  // A payee turns a fixed bucket of vault balance into a note, and later spends
  // it into Kusama Shield with a proof that reveals only a nullifier. The ZK
  // path needs no keeper, so no keeper is authorized here.
  const shieldC = await ethers.getContractAt("PorterShieldVerifier", shieldVerifier, deployer);
  const SHIELD_VK = [
    path.join(__dirname, "..", "circuits", "build", "setShieldVK-calldata.json"),
    path.join(__dirname, "..", "test", "fixtures", "vk-shieldnote.json"),
  ].find((f) => fs.existsSync(f));
  if (!(await shieldC.vkSet())) {
    if (SHIELD_VK) {
      const vk = JSON.parse(fs.readFileSync(SHIELD_VK, "utf-8"));
      await send("shieldVerifier.setVerifyingKey", () =>
        shieldC.setVerifyingKey(
          vk.alpha1, vk.beta2, vk.gamma2, vk.delta2,
          vk.IC0, vk.IC1, vk.IC2, vk.IC3, vk.IC4,
          { gasLimit: GAS_LIMIT }
        )
      );
    } else console.log("  ! no shieldnote verifying key found — shielded payouts stay off");
  } else console.log("  = shieldVerifier VK already set");

  // Kusama Shield's pool on Paseo, and the chain's Poseidon precompile (FARE
  // checked its hash against poseidon-lite on 2026-07). Local chains have
  // neither, so payouts there stay in the clear.
  const SHIELD_POOL = "0x7d5a496bD61b631025A828d9049f6A68e007e0dC";
  const POSEIDON = "0x1d165f6fE5A30422E0E2140e91C8A9B800380637";
  const PAS = 10n ** 18n;
  const BUCKETS = [1n * PAS, 5n * PAS, 25n * PAS, 100n * PAS]; // web/src/shield/ladder.ts
  if (!isLocal) {
    if ((await vaultC.shieldPool()) !== SHIELD_POOL) {
      await send("vault.setShieldPool", () => vaultC.setShieldPool(SHIELD_POOL, { gasLimit: GAS_LIMIT }));
    } else console.log("  = vault shield pool already set");
    if ((await vaultC.shieldBucketCount()) === 0n) {
      await send("vault.setShieldBuckets", () => vaultC.setShieldBuckets(BUCKETS, { gasLimit: GAS_LIMIT }));
    } else console.log("  = vault shield buckets already set");
    // 16 Poseidon calls; one-shot, and it initializes the note tree.
    if ((await vaultC.emptyNoteRoot()) === 0n) {
      await send("vault.setShieldPoseidon", () => vaultC.setShieldPoseidon(POSEIDON, { gasLimit: GAS_LIMIT }));
    } else console.log("  = vault Poseidon already set");
    if ((await vaultC.shieldVerifier()) !== shieldVerifier) {
      await send("vault.setShieldVerifier", () => vaultC.setShieldVerifier(shieldVerifier, { gasLimit: GAS_LIMIT }));
    } else console.log("  = vault shield verifier already wired");
  }

  // ── 2b. Upgradability: registry + router binding ───────────────────────
  console.log("\n2b. Governance router registry");
  const routerC = await ethers.getContractAt("PorterGovernanceRouter", router, deployer);
  const registryEntries: Array<[string, string]> = [
    ["pauseRegistry", pause],
    ["vault", vault],
    ["drivers", drivers],
    ["venues", venues],
    ["orders", orders],
    ["settlement", settlement],
    ["disputes", disputes],
    ["ratings", ratings],
  ];
  for (const [name, addr] of registryEntries) {
    const key = ethers.encodeBytes32String(name);
    if ((await routerC.currentAddrOf(key)) !== addr) {
      await send(`router.register(${name})`, () =>
        routerC.register(key, addr, { gasLimit: GAS_LIMIT })
      );
    } else console.log(`  = router already has ${name}`);
  }
  // Bind the router as upgrade authority on the six PorterUpgradable contracts
  // (pauseRegistry is registered for discovery only — not upgradable).
  for (const [name, addr] of registryEntries.slice(1)) {
    const c = await ethers.getContractAt("PorterVault", addr, deployer); // any PorterUpgradable ABI works for router()
    if ((await c.router()) === ethers.ZeroAddress) {
      await send(`${name}.setRouter`, () => c.setRouter(router, { gasLimit: GAS_LIMIT }));
    } else console.log(`  = ${name} router already bound`);
  }

  // ── 3. Validate ────────────────────────────────────────────────────────
  console.log("\n3. Validation");
  const checks: Array<[string, boolean]> = [
    ["orders.vault", (await ordersC.vault()) === vault],
    ["orders.settlement", (await ordersC.settlement()) === settlement],
    ["orders.disputes", (await ordersC.disputes()) === disputes],
    ["settlement.orders", (await settlementC.orders()) === orders],
    ["settlement.venues", (await settlementC.venues()) === venues],
    ["settlement.verifier", (await settlementC.locationVerifier()) === locationVerifier],
    ["settlement.drivers", (await settlementC.drivers()) === drivers],
    ["verifier VK set", await verifierC.vkSet()],
    ["disputes.orders", (await disputesC.orders()) === orders],
    ["disputes.vault", (await disputesC.vault()) === vault],
    ["disputes.drivers", (await disputesC.drivers()) === drivers],
    ["ratings.orders", (await ratingsC.orders()) === orders],
    ["disputes.arbiter set", (await disputesC.arbiter()) !== ethers.ZeroAddress],
    ["vault auth orders", await vaultC.authorized(orders)],
    ["vault auth disputes", await vaultC.authorized(disputes)],
    ["drivers auth orders", await driversC.authorized(orders)],
    ["drivers auth disputes", await driversC.authorized(disputes)],
    ["venues auth orders", await venuesC.authorized(orders)],
    [
      "router registry complete",
      (
        await Promise.all(
          registryEntries.map(
            async ([n, a]) => (await routerC.currentAddrOf(ethers.encodeBytes32String(n))) === a
          )
        )
      ).every(Boolean),
    ],
    ["shieldVerifier VK set", await shieldC.vkSet()],
    ["vault shield verifier", isLocal || (await vaultC.shieldVerifier()) === shieldVerifier],
    ["vault shield pool", isLocal || (await vaultC.shieldPool()) === SHIELD_POOL],
    ["vault shield buckets", isLocal || (await vaultC.shieldBucketCount()) === BigInt(BUCKETS.length)],
    ["vault note tree ready", isLocal || (await vaultC.emptyNoteRoot()) !== 0n],
    ["orders router bound", (await ordersC.router()) === router],
  ];
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? "OK " : "FAIL"} ${label}`);
    if (!pass) ok = false;
  }
  if (!ok) throw new Error("Wiring validation failed");

  // ── 4. Export for the web app ──────────────────────────────────────────
  // Flat, as web/src/contracts.ts reads it: one address per contract name.
  // The arbiter's public key, recovered from a signature it makes here, so the
  // app can seal a dispute to it. It is checked against disputes.arbiter()
  // before use, so a wrong key in this file is caught, not trusted.
  const arbiterAddress = await disputesC.arbiter();
  let arbiterKey: string | undefined;
  if (arbiterAddress === deployer.address) {
    const message = "porterage:arbiter:v1";
    arbiterKey = ethers.SigningKey.computePublicKey(
      ethers.SigningKey.recoverPublicKey(ethers.hashMessage(message), await deployer.signMessage(message)),
      true,
    );
    if (ethers.computeAddress(arbiterKey) !== arbiterAddress) throw new Error("the arbiter key doesn't match its address");
  } else {
    console.log(`  ! arbiter ${arbiterAddress} is not the deploy key: publish its public key by hand`);
  }

  const exportBook = {
    ...book,
    arbiter: arbiterAddress,
    ...(arbiterKey ? { arbiterKey } : {}),
    network: network.name,
    chainId: Number((await provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(WEB_ADDR_FILE), { recursive: true });
  fs.writeFileSync(WEB_ADDR_FILE, JSON.stringify(exportBook, null, 2) + "\n");
  console.log(`\nAddresses written to ${ADDR_FILE} and ${WEB_ADDR_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
