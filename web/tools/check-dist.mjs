// Does the bundle reference anything it does not ship?
//
//   node tools/check-dist.mjs [dist]
//
// This exists because of one line in a vite plugin. `inlineCss` folded the
// stylesheet into index.html and then deleted the asset, on the reasoning that
// an inlined stylesheet leaves an orphan behind. It does not: Vite records a
// CSS dependency on every chunk that needs one, and `__vitePreload` fetches it
// before running the chunk. So every lazily loaded screen that declared the
// stylesheet asked for a file that was not published, the fetch 404'd, and the
// dynamic import REJECTED — "Unable to preload CSS for …". The screen did not
// open, and with no error boundary at the time, the whole app went with it.
//
// Nothing caught it. The typecheck passes: the reference is generated, not
// written. The tests pass: they do not build. The build passes: dropping an
// asset is exactly what the plugin was asked to do. It only fails on a device,
// on the screens nobody opens until they have money in them.
//
// So: read the built output, find every relative path it mentions, and check
// each one exists. Cheap, and it is the specific shape of mistake a build step
// that rewrites the bundle will make again.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(
  process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist")
);

/** Every file under dist, as paths relative to it. */
function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(full.slice(base.length + 1).replaceAll("\\", "/"));
  }
  return out;
}

const present = new Set(walk(root));

// What a bundle actually fetches is written as an explicitly relative path —
// "./Backup-B3Kl85az.js", "./index-BOkboU74.css" — or one rooted at assets/.
// Requiring that prefix is what keeps a library's incidental "package.json"
// out of the results, and it must be part of the match rather than stripped
// before it: the first version of this check captured the path without the
// "./", could no longer tell the two apart, and silently passed the very
// deletion it was written to catch.
const REFERENCE =
  /["'`(]\s*(\.\/[\w.-]+|(?:\.\/)?assets\/[\w./-]+)\.(js|css|wasm|zkey|json|svg|png|jpe?g|webp|woff2?)\b/g;

/** Fetched by a path built at runtime, so no string in the bundle holds it. */
const RUNTIME_ONLY = [/^shield\//];

const missing = new Map();
for (const file of present) {
  if (!/\.(js|html|css)$/.test(file)) continue;
  const from = dirname(file);
  const text = readFileSync(join(root, file), "utf8");
  for (const [, ref, ext] of text.matchAll(REFERENCE)) {
    // Relative to the file that names it, which is how Vite writes chunk deps.
    const path = join(from === "." ? "" : from, `${ref}.${ext}`)
      .replaceAll("\\", "/")
      .replace(/^\.\//, "");
    if (present.has(path) || RUNTIME_ONLY.some((r) => r.test(path))) continue;
    if (!missing.has(path)) missing.set(path, []);
    missing.get(path).push(file);
  }
}

if (missing.size) {
  console.error(`\n${root} references ${missing.size} file(s) it does not ship:\n`);
  for (const [path, from] of missing) {
    console.error(`   ${path}`);
    console.error(`      wanted by ${[...new Set(from)].join(", ")}`);
  }
  console.error(
    `\nA missing chunk or stylesheet makes the dynamic import that wants it\n` +
      `reject, so the screen never opens. Check any plugin that edits the bundle.\n`
  );
  process.exit(1);
}

console.log(`dist: ${present.size} files, every reference resolves`);
