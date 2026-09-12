import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// The dev server proxies to the running backend rather than the app holding an
// absolute origin. FRONTEND_SPEC §0.2: do not mock the API.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  build: {
    rollupOptions: {
      output: {
        // ECharts is most of the bundle and changes rarely. Splitting it keeps
        // the application chunk small enough to re-download on every deploy
        // without re-fetching the charting library with it.
        manualChunks: {
          echarts: ["echarts"],
          vendor: ["react", "react-dom", "react-router-dom", "@tanstack/react-query"],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET ?? "http://localhost:8000",
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/api/, ""),
      },
      "/ws": {
        target: process.env.VITE_API_TARGET ?? "http://localhost:8000",
        ws: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
  },
} as never);
