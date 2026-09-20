// Does a connection actually open from a signal small enough to publish?
//
//   node tools/rtc-loopback.mjs
//
// There is no RTCPeerConnection in node and no second phone here, so this
// drives a real browser: it bundles tools/rtc-entry.ts, opens it in headless
// Chromium — the same engine family as the app's WebView — and waits for the
// page to report back. What it proves is the risky part: that an SDP rebuilt
// from 113 bytes is one a real WebRTC stack will accept.
//
// It does not prove two phones can reach each other. Nothing here can; that
// needs Phase 7 and two devices on the same network.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8731;
const BROWSERS = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];

const out = mkdtempSync(join(tmpdir(), "porterage-rtc-"));
const esbuild = spawn(
  join(HERE, "..", "node_modules", ".bin", "esbuild"),
  [join(HERE, "rtc-entry.ts"), "--bundle", "--format=iife", `--outfile=${join(out, "bundle.js")}`, "--log-level=error"],
  { stdio: "inherit" },
);
await new Promise((r, x) => esbuild.on("exit", (c) => (c === 0 ? r() : x(new Error("the bundle failed")))));
writeFileSync(join(out, "index.html"), '<!doctype html><meta charset=utf-8><title>rtc</title><script src="bundle.js"></script>');

const result = new Promise((resolve) => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "access-control-allow-origin": "*" });
      res.end("ok");
      if (req.method === "POST") {
        server.close();
        resolve(body);
      }
    });
  });
  server.listen(PORT);
  setTimeout(() => {
    server.close();
    resolve("TIMEOUT: the page never reported back");
  }, 90_000);
});

let browser = null;
for (const name of BROWSERS) {
  try {
    browser = spawn(name, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `file://${join(out, "index.html")}`], {
      stdio: "ignore",
    });
    await new Promise((r, x) => {
      browser.once("spawn", r);
      browser.once("error", x);
    });
    break;
  } catch {
    browser = null;
  }
}
if (!browser) {
  console.log("no Chromium or Chrome on this machine, so the handshake can't be checked here");
  process.exit(0);
}

const said = await result;
browser.kill();
console.log(said);
process.exit(said.startsWith("OK") ? 0 : 1);
