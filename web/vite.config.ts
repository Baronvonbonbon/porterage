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
 * The asset is dropped from the bundle afterwards so no orphan is published.
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
          delete ctx.bundle[name];
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
