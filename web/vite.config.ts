import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Products are served from a content-addressed bundle; relative paths keep it portable.
  base: "./",
  server: { port: 5190 },
  test: { environment: "node" },
});
