import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mountDashboardStatic } from "../src/http/dashboard-static.ts";

async function serve(dist: string | undefined): Promise<{ base: string; server: Server }> {
  const app = express();
  mountDashboardStatic(app, { dist, mediaOrigins: ["https://s3.example.com"] });
  app.use((_req, res) => {
    res.status(404).json({ error: "fallthrough" });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        base: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`,
        server,
      });
    });
  });
}

describe("dashboard static hosting", () => {
  let dist: string;
  let built: { base: string; server: Server };
  let missing: { base: string; server: Server };

  beforeAll(async () => {
    dist = mkdtempSync(join(tmpdir(), "studix-dist-"));
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><div id=root></div>");
    writeFileSync(join(dist, "assets", "app-abc.js"), "console.log(1)");
    built = await serve(dist);
    missing = await serve(join(dist, "does-not-exist"));
  });
  afterAll(() => {
    built.server.close();
    missing.server.close();
    rmSync(dist, { recursive: true, force: true });
  });

  it("serves the shell with CSP and no-cache, and hashed assets as immutable", async () => {
    const index = await fetch(`${built.base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-security-policy")).toContain(
      "media-src 'self' blob: https://s3.example.com",
    );
    expect(index.headers.get("cache-control")).toBe("no-cache");
    const asset = await fetch(`${built.base}/assets/app-abc.js`);
    expect(asset.headers.get("cache-control")).toContain("immutable");
  });

  it("falls back to the shell for browser navigations but never for reserved prefixes", async () => {
    const deep = await fetch(`${built.base}/jobs/job_1`, { headers: { accept: "text/html" } });
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain("id=root");
    const api = await fetch(`${built.base}/api/unknown`, { headers: { accept: "text/html" } });
    expect(api.status).toBe(404);
    const asset = await fetch(`${built.base}/assets/missing.js`);
    expect(asset.status).toBe(404);
  });

  it("answers 503 for navigations when the build is missing", async () => {
    const res = await fetch(`${missing.base}/`);
    expect(res.status).toBe(503);
  });

  it("serves the shell when the build sits under a dot directory", async () => {
    const parent = mkdtempSync(join(tmpdir(), "studix-dot-"));
    const hiddenDist = join(parent, ".hidden", "dist");
    mkdirSync(hiddenDist, { recursive: true });
    writeFileSync(join(hiddenDist, "index.html"), "<!doctype html><div id=root></div>");
    const hidden = await serve(hiddenDist);
    try {
      const root = await fetch(`${hidden.base}/`);
      expect(root.status).toBe(200);
      expect(await root.text()).toContain("id=root");
      const deep = await fetch(`${hidden.base}/projects/p1/review`, { headers: { accept: "text/html" } });
      expect(deep.status).toBe(200);
    } finally {
      hidden.server.close();
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
