import tailwindcss from "@tailwindcss/vite";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solid(), tailwindcss()],
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
