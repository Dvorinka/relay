import tailwindcss from "@tailwindcss/vite";
import solid from "vite-plugin-solid";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  plugins: [solid(), tailwindcss()],
  // `vite build --mode singlefile` emits one JS chunk with all dynamic
  // imports inlined — scripts/inline-bundle.mjs folds it into a single HTML
  // file that the mobile app ships for cold-start local mode.
  build:
    mode === "singlefile"
      ? {
          outDir: "dist-single",
          assetsInlineLimit: 100 * 1024 * 1024,
          rollupOptions: { output: { inlineDynamicImports: true } },
        }
      : {},
  // Stamped by release CI (VITE_APP_VERSION=v1.2.3); "dev" locally.
  define: {
    __APP_VERSION__: JSON.stringify(
      loadEnv(mode, "", "VITE_").VITE_APP_VERSION ?? "dev",
    ),
  },
  // The Excalidraw island must share one React copy with react-dom —
  // without this, the dep optimizer gives each its own react instance and
  // hooks blow up ("invalid hook call").
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    include: ["react", "react-dom", "@excalidraw/excalidraw"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/mcp": "http://localhost:8080",
    },
  },
  test: {
    environment: "node",
  },
}));
