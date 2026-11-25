/**
 * The React dashboard. `npm run build -w @mishlav/dashboard` writes dist/, which the backend serves at /dashboard-new
 * (apps/backend/src/routes/dashboard.ts). `npm run dashboard:dev`: Vite on 127.0.0.1 only, with the API proxied to the
 * local server (default http://127.0.0.1:8787, or DASHBOARD_API), so the session cookie stays same-origin.
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.DASHBOARD_API ?? "http://127.0.0.1:8787";
const proxied = ["/api", "/auth", "/test", "/tools", "/healthz"];

export default defineConfig({
  base: "/dashboard-new/",
  plugins: [react()],
  // no VITE_* variables reach the page: nothing from the environment is ever bundled
  envPrefix: "DASHBOARD_PUBLIC_NONE_",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(proxied.map((p) => [p, { target: api, changeOrigin: false }])),
  },
  preview: { host: "127.0.0.1" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    // file names the backend's static-file pattern allows: assets/<letters, digits, _ and ->.js|css
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
