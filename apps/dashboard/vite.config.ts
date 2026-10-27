import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Production: `vite build` writes `dist/`, served by the app process at `/` (same origin as `/api`).
 * Development: `vite` proxies `/api` and `/mcp` to the local app (STUDIX_DEV_API, default
 * http://localhost:8787) and rewrites Origin so the app's CSRF/Origin guard sees its own origin.
 */
const target = process.env.STUDIX_DEV_API ?? "http://localhost:8787";
const targetOrigin = new URL(target).origin;

const proxy = {
  target,
  changeOrigin: true,
  configure(server: {
    on(event: "proxyReq", fn: (req: { setHeader(k: string, v: string): void }) => void): void;
  }) {
    server.on("proxyReq", (req) => req.setHeader("origin", targetOrigin));
  },
};

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: { port: 5173, strictPort: true, proxy: { "/api": proxy, "/mcp": proxy } },
});
