import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

// The registry serves the built dashboard under `/dashboard` (express.static),
// so production assets must be referenced from `/dashboard/` — not `/`, which
// would 404 and make the page render blank. The dev server (port 5173, with the
// proxy below) keeps base `/`.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/dashboard/" : "/",
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "/src": resolve(__dirname, "src"),
      src: resolve(__dirname, "src"),
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/agents": "http://localhost:4999",
      "/health": "http://localhost:4999",
      "/events": "http://localhost:4999",
      "/ws": {
        target: "ws://localhost:4999",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
}));
