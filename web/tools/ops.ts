// The arbiter's command line (npx vite-node tools/ops.ts -- <command>).
//
// The console in the app (src/views/Ops.tsx) shows the same queue, but it can
// only rule when the device holds the arbiter's key. Today the arbiter is the
// deploy key, which lives in a file on this computer, so this is what actually
// rules — and it shares the queue and the arithmetic with the app, so the two
// cannot drift apart.
//
//   list                    the open disputes, with their order and driver
//   list --all              settled ones too
//   show <disputeId>        open the sealed case, and the photo if one is in it
//   rule <disputeId> <customerShareBps> [--slash PAS] [--fault] [--bond-to-treasury]
//
// A ruling asks for confirmation unless --yes is passed, because it can't be
// taken back.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  computeAddress,
  formatEther,
  parseEther,
} from "ethers";
import { CHAIN } from "../src/config";
import DEPLOYED from "../src/deployed.json";
import DISPUTES_ABI from "../src/abi/PorterDisputes.json";
import ORDERS_ABI from "../src/abi/PorterOrders.json";
import DRIVERS_ABI from "../src/abi/PorterDrivers.json";
import { decodeCase } from "../src/order/dispute";
import { openWithKey } from "../src/order/evidence";
import { open as openEnvelope } from "../src/order/seal";
import { bondGoesTo, slashExceedsStake, splitEscrow } from "../src/ops/ruling";

const book = DEPLOYED as Record<string, string>;
const eth = new JsonRpcProvider(CHAIN.ethRpc, Number(CHAIN.chainId), {
  staticNetwork: true,
});
const arbiter = new Wallet(
  readFileSync(
    join(homedir(), ".config", "porterage", "deploy-key"),
    "utf8"
  ).trim(),
  eth
);

const disputes = new Contract(book.disputes, DISPUTES_ABI as never, eth);
const orders = new Contract(book.orders, ORDERS_ABI as never, eth);
const drivers = new Contract(book.drivers, DRIVERS_ABI as never, eth);

const ZERO = `0x${"0".repeat(40)}`;
const pas = (v: bigint) => `${Number(formatEther(v)).toFixed(4)} PAS`;
const STATUS = [
  "—",
  "Open",
  "Assigned",
  "PickedUp",
  "Delivered",
  "Cancelled",
  "Disputed",
  "Resolved",
];

const argv = process.argv.slice(2).filter((a) => a !== "--");
const command = argv[0] ?? "list";
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function row(id: bigint) {
  const d = await disputes.disputes(id);
  if (Number(d.status) === 0) return null;
  const o = await orders.orders(d.orderId);
  const record = o.driver !== ZERO ? await drivers.drivers(o.driver) : null;
  return { id, d, o, record };
}

async function list() {
  const onChain: string = await disputes.arbiter();
  console.log(
    `arbiter ${onChain}${
      onChain.toLowerCase() === arbiter.address.toLowerCase()
        ? " (this key)"
        : " — NOT this key"
    }`
  );
  const next = Number(await disputes.nextDisputeId());
  if (next <= 1) return console.log("no disputes yet");
  for (let id = next - 1; id >= 1; id--) {
    const r = await row(BigInt(id));
    if (!r) continue;
    const open = Number(r.d.status) === 1;
    if (!open && !flag("all")) continue;
    console.log(
      `#${id}  order #${r.d.orderId} ${
        STATUS[Number(r.o.status)]
      }  escrow ${pas(r.o.escrow)}  opened by ${String(r.d.opener).slice(
        0,
        10
      )}…  ${open ? "OPEN" : "settled"}`
    );
    if (r.record) {
      console.log(
        `      driver ${String(r.o.driver).slice(0, 10)}…  ${
          r.record.delivered
        } delivered / ${r.record.failed} failed, staked ${pas(r.record.stake)}`
      );
    }
  }
}

async function show(id: bigint) {
  const r = await row(id);
  if (!r) return console.log(`no dispute #${id}`);
  console.log(
    `#${id} on order #${r.d.orderId} — ${
      STATUS[Number(r.o.status)]
    }, escrow ${pas(r.o.escrow)}`
  );
  console.log(`opened by ${r.d.opener}, bond ${pas(r.d.bond)}`);

  const uri: string = r.d.evidenceURI;
  const PREFIX = "porterage:case:1:";
  if (!uri.startsWith(PREFIX))
    return console.log(`evidenceURI: ${uri || "(none)"}`);
  const plain = await openEnvelope(
    { signingKey: arbiter.signingKey },
    8,
    Buffer.from(uri.slice(PREFIX.length), "hex")
  );
  if (!plain)
    return console.log(
      "the case is sealed to another key — this one cannot read it"
    );
  const c = decodeCase(plain)!;
  console.log(`\n  “${c.reason}”\n`);
  if (!c.photoKey) return console.log("no photo key was enclosed");

  for (const party of [r.o.customer, r.o.driver].filter(
    (p: string) => p !== ZERO
  )) {
    const e = await disputes.evidenceOf(r.d.orderId, party);
    if (!e[0] || e[0] === `0x${"0".repeat(64)}`) continue;
    console.log(
      `photo committed by ${String(party).slice(0, 10)}… at ${new Date(
        Number(e[1]) * 1000
      ).toISOString()}, key ${String(e[0]).slice(0, 14)}…`
    );
    console.log(
      "  (the bytes live on Bulletin; fetching them needs the app, which is where the photo can be looked at)"
    );
    void openWithKey; // the app opens it; here we only show that the key is present
  }
}

async function rule(id: bigint) {
  const bps = Number(argv[2]);
  const r = await row(id);
  if (!r) return console.log(`no dispute #${id}`);
  if (Number(r.d.status) !== 1) return console.log(`#${id} is already settled`);

  const split = splitEscrow(r.o.escrow, bps); // throws on a share the contract would refuse
  const slash = parseEther(value("slash") ?? "0");
  const atFault = flag("fault");
  const openerWins = !flag("bond-to-treasury");

  console.log(`#${id} on order #${r.d.orderId}, escrow ${pas(r.o.escrow)}`);
  console.log(
    `  customer ${pas(split.customerAmt)}   driver ${pas(split.driverAmt)}`
  );
  console.log(`  bond ${pas(r.d.bond)} ${bondGoesTo(openerWins)}`);
  console.log(
    `  slash ${pas(slash)}${
      r.record && slashExceedsStake(slash, r.record.stake)
        ? ` — MORE than the ${pas(
            r.record.stake
          )} staked; the contract takes what's there`
        : ""
    }`
  );
  console.log(`  driver marked at fault: ${atFault}`);

  if (!flag("yes")) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await rl.question(
      "\nThis cannot be taken back. Type the dispute number to confirm: "
    );
    rl.close();
    if (answer.trim() !== String(id)) return console.log("nothing done");
  }

  const tx = await new Contract(
    book.disputes,
    DISPUTES_ABI as never,
    arbiter
  ).resolve(id, bps, openerWins, atFault, slash);
  await tx.wait();
  console.log(`ruled: ${tx.hash}`);
}

if (computeAddress(arbiter.signingKey.publicKey) !== arbiter.address)
  throw new Error("the key file is not a key");

if (command === "list") await list();
else if (command === "show") await show(BigInt(argv[1]));
else if (command === "rule") await rule(BigInt(argv[1]));
else
  console.log(
    "commands: list [--all] | show <disputeId> | rule <disputeId> <customerShareBps> [--slash PAS] [--fault] [--bond-to-treasury] [--yes]"
  );
process.exit(0);
