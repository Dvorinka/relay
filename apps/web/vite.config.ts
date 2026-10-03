import tailwindcss from "@tailwindcss/vite";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solid(), tailwindcss()],
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
});
