import type { Client } from "@modelcontextprotocol/client";
import type { TenantContext } from "@studix/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./app-test-harness.ts";

interface Envelope {
  status: "ok" | "error";
  data: {
    assets?: { id: string; role: string; path: string; tags: string[]; mime?: string }[];
    asset?: { role: string; path: string };
  } | null;
  error?: { code: string };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return result.structuredContent as unknown as Envelope;
}

describe("asset library over MCP and the dashboard API (Postgres)", () => {
  let app: TestApp;
  let tenantA: TenantContext;
  let tenantB: TenantContext;
  let editor: Client;
  let reader: Client;
  let other: Client;
  const by = { type: "user", id: "usr_1" } as const;

  beforeAll(async () => {
    app = await startTestApp();
    tenantA = await app.provisionTenant("asset-lib-a");
    tenantB = await app.provisionTenant("asset-lib-b");
    editor = await app.connect(await app.createKey(tenantA));
    reader = await app.connect(await app.createKey(tenantA, "viewer"));
    other = await app.connect(await app.createKey(tenantB));
  });
  afterAll(async () => {
    await app?.close();
  });

  it("lists by role and folder, organizes an asset, and keeps tenants apart", async () => {
    const { assets } = app.db.repos;
    const sfx = await assets.create(tenantA, { kind: "audio", name: "door-slam-sfx.wav", createdBy: by });
    await assets.addVersion(tenantA, {
      assetId: sfx.id,
      storageKey: `assets/${sfx.id}/v1/door-slam-sfx.wav`,
      sha256: "a".repeat(64),
      mime: "audio/wav",
      bytes: 10,
      durationMs: 900,
      provenance: { source: "generated" },
      createdBy: by,
    });
    await assets.create(tenantA, {
      kind: "image",
      name: "frame.png",
      role: "keyframe",
      path: "ep03/sc01/s05",
      createdBy: by,
    });

    const sounds = await call(editor, "studix_list_assets", { role: "sfx" });
    expect(sounds.data?.assets).toMatchObject([{ id: sfx.id, role: "sfx", path: "sfx", mime: "audio/wav" }]);
    const shots = await call(editor, "studix_list_assets", { path: "ep03" });
    expect(shots.data?.assets).toHaveLength(1);
    expect((await call(other, "studix_list_assets")).data?.assets).toEqual([]);

    const moved = await call(editor, "studix_update_asset", {
      assetId: sfx.id,
      role: "vfx",
      path: "ep03/sc01/s05",
      tags: ["door"],
    });
    expect(moved.data?.asset).toMatchObject({ role: "vfx", path: "ep03/sc01/s05" });
    expect((await call(editor, "studix_list_assets", { path: "ep03/sc01" })).data?.assets).toHaveLength(2);

    const denied = await call(reader, "studix_update_asset", { assetId: sfx.id, role: "prop" });
    expect(denied.error?.code).toBe("FORBIDDEN");
    const foreign = await call(other, "studix_update_asset", { assetId: sfx.id, role: "prop" });
    expect(foreign.error?.code).toBe("NOT_FOUND");
    const empty = await call(editor, "studix_update_asset", { assetId: sfx.id });
    expect(empty.error?.code).toBe("VALIDATION");
  });

  it("serves the dashboard Assets page", async () => {
    const cookie = await app.signUp(`assets-${Date.now()}@example.test`);
    const empty = await app.api("GET", "/api/assets?role=sfx", { cookie });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ assets: [] });
    const bad = await app.api("GET", "/api/assets?role=nonsense", { cookie });
    expect(bad.status).toBe(400);
    expect((await app.api("GET", "/api/assets")).status).toBe(401);
  });
});
