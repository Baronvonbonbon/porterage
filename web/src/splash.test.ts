// The splash paints before any of this app exists, so it cannot import from it.
//
// That means the mark is drawn twice — once as JSX in Mark.tsx, once as raw
// SVG inlined in index.html — and two copies of the same drawing drift. The
// failure is quiet and slightly embarrassing: the logo on the loading screen
// stops being the logo.
//
// These tests compare the geometry of the two, and check the splash keeps the
// properties it exists for: it is in the document itself rather than fetched,
// it styles itself without the stylesheet, and it can be dismissed.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const html = readFileSync(join(root, "index.html"), "utf-8");
const mark = readFileSync(join(root, "src", "Mark.tsx"), "utf-8");

/** The bits of an SVG that decide what it looks like, in a comparable shape. */
function geometry(src: string) {
  // Lookbehind, because `id="root"` also ends in a d.
  const paths = [...src.matchAll(/(?<![a-zA-Z-])d="([^"]+)"/g)].map((m) =>
    m[1].trim()
  );
  const rect = /<rect([^>]*)>/.exec(src)?.[1] ?? "";
  const attrs = Object.fromEntries(
    [...rect.matchAll(/([a-zA-Z-]+)="([^"]+)"/g)].map((m) => [m[1], m[2]])
  );
  const transform = /transform="([^"]+)"/.exec(src)?.[1] ?? "";
  return { paths, attrs, transform };
}

describe("the mark", () => {
  it("is drawn identically in index.html and Mark.tsx", () => {
    const inHtml = geometry(html);
    const inTsx = geometry(mark);
    expect(inHtml.paths, "path data").to.deep.equal(inTsx.paths);
    expect(inHtml.attrs, "the load").to.deep.equal(inTsx.attrs);
    expect(inHtml.transform, "the lean").to.equal(inTsx.transform);
  });

  it("draws in currentColor, so one asset serves both themes", () => {
    // A hardcoded fill would look deliberate in daylight and wrong at night —
    // the same bug the stylesheet's comment describes.
    expect(mark).toContain('stroke="currentColor"');
    expect(html).toContain('stroke="currentColor"');
  });
});

describe("the splash", () => {
  it("is in the document, not fetched", () => {
    // The entire point. Anything referenced by URL is another round trip spent
    // looking at nothing.
    const splash = html.slice(html.indexOf('<div id="splash"'));
    expect(splash.slice(0, splash.indexOf("</div>"))).to.not.match(
      /<img|src=|url\(/
    );
  });

  it("styles itself without the stylesheet", () => {
    // The built page links styles.css, and that link blocks paint too. The
    // splash must not wait for it.
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain("#splash");
    expect(head).toContain("--splash-bg");
  });

  it("answers to the dark theme before any JavaScript has run", () => {
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain('[data-theme="dark"]');
  });

  it("says something when the load is taking too long", () => {
    // A bar going nowhere is indistinguishable from a hang.
    expect(html).toMatch(/setTimeout\([\s\S]*?Still loading/);
  });

  it("exposes exactly the two calls main.tsx makes", () => {
    const main = readFileSync(join(root, "src", "main.tsx"), "utf-8");
    expect(html).toContain("window.__porterage");
    for (const fn of ["step:", "done:"]) expect(html).toContain(fn);
    expect(main).toContain("__porterage?.step");
    expect(main).toContain("__porterage?.done");
  });

  it("is cleared even when startup fails", () => {
    // Otherwise a thrown error leaves a loading screen up forever, which reads
    // as a hang rather than as the failure it is.
    const main = readFileSync(join(root, "src", "main.tsx"), "utf-8");
    const tail = main.slice(main.indexOf("start().catch"));
    expect(tail).toContain("splash.done()");
    expect(tail).toContain("createRoot");
  });
});
