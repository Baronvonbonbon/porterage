import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Fold the stylesheet into the page.
 *
 * The splash in index.html styles itself inline so it can paint from the first
 * bytes of the document — but a `<link rel="stylesheet">` in the head is
 * render-blocking, so the browser held that paint back until an 8 KB file had
 * made a second round trip over IPFS anyway. Inlining it costs nothing (the
 * file is smaller than the request that fetched it) and is the difference
 * between the splash appearing immediately and appearing after a network hop.
 *
 * THE FILE STAYS IN THE BUNDLE. An earlier version deleted it, reasoning that
 * an inlined stylesheet leaves an orphan — and it does not. Vite records a CSS
 * dependency on every chunk that needs one, and `__vitePreload` fetches it
 * before running the chunk. With the file gone, that fetch 404s and the
 * dynamic import REJECTS: "Unable to preload CSS for …". Every lazily loaded
 * screen that declared the stylesheet — Customer, Books, Funds — failed to
 * open, which is what took down the driver's Earnings and the venue's Takings.
 *
 * So it is published as well as inlined. The cost is one 8 KB request, made
 * only when a lazy chunk loads and cached from then on; the alternative is a
 * screen that cannot open at all.
 */
function inlineCss(): Plugin {
  return {
    name: "porterage-inline-css",
    enforce: "post",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (!ctx.bundle) return html;
        let out = html;
        for (const [name, asset] of Object.entries(ctx.bundle)) {
          if (!name.endsWith(".css") || asset.type !== "asset") continue;
          const file = name.split("/").pop()!;
          const link = new RegExp(
            `<link[^>]+href="[^"]*${file.replace(/\./g, "\\.")}"[^>]*>`
          );
          if (!link.test(out)) continue;
          out = out.replace(link, `<style>${String(asset.source)}</style>`);
        }
        return out;
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), inlineCss()],
  // Products are served from a content-addressed bundle; relative paths keep it portable.
  base: "./",
  server: { port: 5190 },
  test: { environment: "node" },
});
