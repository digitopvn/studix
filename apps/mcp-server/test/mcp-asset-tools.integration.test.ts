import type { Client } from "@modelcontextprotocol/client";
import { createAssetService, type TenantContext } from "@studix/core";
import { InMemoryStorageAdapter } from "@studix/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./app-test-harness.ts";

interface Envelope {
  status: "ok" | "error";
  // biome-ignore lint/suspicious/noExplicitAny: tool payloads are asserted field by field
  data: Record<string, any> | null;
  next: { tool: string; arguments?: Record<string, unknown> }[];
  error?: { code: string; message: string };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return result.structuredContent as unknown as Envelope;
}

const b64 = (text: string) => Buffer.from(text).toString("base64");

describe("project asset tools over MCP, WebMCP and /api/assets (Postgres)", () => {
  let app: TestApp;
  let a: TenantContext;
  let b: TenantContext;
  let editor: string;
  let viewer: string;
  let otherEditor: string;

  beforeAll(async () => {
    app = await startTestApp();
    app.deps.assets = createAssetService({
      assets: app.db.repos.assets,
      projects: app.db.repos.projects,
      audit: app.db.repos.audit,
      revisions: app.db.repos.revisions,
      storage: new InMemoryStorageAdapter(),
      fetchUrl: async (url) => ({
        body: new TextEncoder().encode(`fetched ${url}`),
        contentType: "image/png",
      }),
    });
    a = await app.provisionTenant("assets-a");
    b = await app.provisionTenant("assets-b");
    editor = await app.createKey(a, "editor");
    viewer = await app.createKey(a, "viewer");
    otherEditor = await app.createKey(b, "editor");
  });
  afterAll(async () => {
    await app?.close();
  });

  it("lists six small tools with honest hints", async () => {
    const { tools } = await (await app.connect(editor)).listTools();
    const assetTools = tools.filter((t) =>
      /^studix_(list|get|upload|update|delete|restore)_asset/.test(t.name),
    );
    expect(assetTools.map((t) => t.name).sort()).toEqual([
      "studix_delete_asset",
      "studix_get_asset",
      "studix_list_assets",
      "studix_restore_asset",
      "studix_update_asset",
      "studix_upload_asset",
    ]);
    const byName = Object.fromEntries(assetTools.map((t) => [t.name, t.annotations]));
    expect(byName.studix_list_assets).toMatchObject({ readOnlyHint: true });
    expect(byName.studix_upload_asset).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(byName.studix_delete_asset).toMatchObject({ destructiveHint: false, idempotentHint: true });
    // Token cost of the whole set stays small.
    expect(JSON.stringify(assetTools).length).toBeLessThan(12_000);
  });

  it("upload → list → get → update → delete → restore", async () => {
    const client = await app.connect(editor);
    const up = await call(client, "studix_upload_asset", { name: "logo.png", base64: b64("logo-1") });
    expect(up.status).toBe("ok");
    const id = up.data?.asset.id as string;
    expect(up.data).toMatchObject({ version: 1, unchanged: false });
    expect(up.next[0]).toMatchObject({ tool: "studix_get_asset", arguments: { assetId: id } });

    const v2 = await call(client, "studix_upload_asset", { assetId: id, base64: b64("logo-2") });
    expect(v2.data).toMatchObject({ version: 2 });
    const imported = await call(client, "studix_upload_asset", { url: "https://cdn.example.com/bg/sky.png" });
    expect(imported.data?.asset).toMatchObject({ name: "sky.png", kind: "image" });

    const listed = await call(client, "studix_list_assets", { q: "logo" });
    expect(listed.data?.items.map((x: { id: string }) => x.id)).toEqual([id]);

    const got = await call(client, "studix_get_asset", { assetId: id });
    expect(got.data?.versions).toHaveLength(2);
    expect(got.data?.url).toMatch(/^(https?|memory):\/\//);

    const renamed = await call(client, "studix_update_asset", { assetId: id, name: "logo-final.png" });
    expect(renamed.data?.asset.name).toBe("logo-final.png");

    const del = await call(client, "studix_delete_asset", { assetId: id });
    expect(del.data?.asset.deletedAt).toBeDefined();
    expect(del.next[0]?.tool).toBe("studix_restore_asset");
    expect((await call(client, "studix_list_assets", { q: "logo" })).data?.items).toEqual([]);
    const restored = await call(client, "studix_restore_asset", { assetId: id });
    expect(restored.data?.asset.deletedAt).toBeUndefined();
    expect((await call(client, "studix_list_assets", { q: "logo" })).data?.items).toHaveLength(1);

    const audit = await app.db.repos.audit.list(a, { subjectId: id });
    expect(audit.items.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "asset.uploaded",
        "asset.version_added",
        "asset.updated",
        "asset.deleted",
        "asset.restored",
      ]),
    );
  });

  it("denies writes to a viewer key and anything across workspaces", async () => {
    const mine = await call(await app.connect(editor), "studix_upload_asset", {
      name: "private.png",
      base64: b64("secret"),
    });
    const id = mine.data?.asset.id as string;

    const viewerClient = await app.connect(viewer);
    expect((await call(viewerClient, "studix_list_assets")).status).toBe("ok");
    expect((await call(viewerClient, "studix_get_asset", { assetId: id })).status).toBe("ok");
    for (const [tool, args] of [
      ["studix_upload_asset", { name: "x.png", base64: b64("x") }],
      ["studix_update_asset", { assetId: id, name: "x" }],
      ["studix_delete_asset", { assetId: id }],
      ["studix_restore_asset", { assetId: id }],
    ] as const) {
      expect((await call(viewerClient, tool, args)).error?.code).toBe("FORBIDDEN");
    }

    const other = await app.connect(otherEditor);
    expect(
      (await call(other, "studix_list_assets")).data?.items.map((x: { name: string }) => x.name),
    ).not.toContain("private.png");
    for (const [tool, args] of [
      ["studix_get_asset", { assetId: id }],
      ["studix_update_asset", { assetId: id, name: "stolen" }],
      ["studix_delete_asset", { assetId: id }],
      ["studix_upload_asset", { assetId: id, base64: b64("overwrite") }],
    ] as const) {
      expect((await call(other, tool, args)).error?.code).toBe("NOT_FOUND");
    }
    expect(
      (await call(await app.connect(editor), "studix_get_asset", { assetId: id })).data?.asset.name,
    ).toBe("private.png");
  });

  it("serves the same tools through WebMCP and the REST routes", async () => {
    const cookie = await app.signUp(`assets-${Date.now()}@example.test`);
    const listed = (await (await app.api("GET", "/api/webmcp/tools", { cookie })).json()) as {
      tools: Array<{ name: string; inputSchema: unknown }>;
    };
    const mcp = new Map(
      (await (await app.connect(editor)).listTools()).tools.map((t) => [t.name, t.inputSchema]),
    );
    const web = listed.tools.filter((t) => t.name.endsWith("_asset") || t.name === "studix_list_assets");
    expect(web).toHaveLength(6);
    for (const t of web) expect(t.inputSchema).toEqual(mcp.get(t.name));

    const viaWeb = (await (
      await app.api("POST", "/api/webmcp/tools/studix_upload_asset", {
        cookie,
        body: { name: "web.png", base64: b64("web") },
      })
    ).json()) as { structuredContent: Envelope };
    expect(viaWeb.structuredContent.status).toBe("ok");

    const created = await app.api("POST", "/api/assets", {
      cookie,
      body: { name: "rest.mp3", base64: b64("rest") },
    });
    expect(created.status).toBe(201);
    const asset = (await created.json()) as { asset: { id: string; kind: string } };
    expect(asset.asset.kind).toBe("audio");
    const page = (await (await app.api("GET", "/api/assets?kind=audio", { cookie })).json()) as {
      items: Array<{ id: string }>;
    };
    expect(page.items.map((x) => x.id)).toEqual([asset.asset.id]);
    const one = (await (await app.api("GET", `/api/assets/${asset.asset.id}`, { cookie })).json()) as {
      versions: unknown[];
      url?: string;
    };
    expect(one.versions).toHaveLength(1);
    expect(
      (await app.api("PATCH", `/api/assets/${asset.asset.id}`, { cookie, body: { name: "song.mp3" } }))
        .status,
    ).toBe(200);
    expect((await app.api("DELETE", `/api/assets/${asset.asset.id}`, { cookie })).status).toBe(200);
    expect(
      ((await (await app.api("GET", "/api/assets?state=deleted", { cookie })).json()) as { items: unknown[] })
        .items,
    ).toHaveLength(1);
    expect((await app.api("POST", `/api/assets/${asset.asset.id}/restore`, { cookie })).status).toBe(200);
    expect((await app.api("GET", "/api/assets/ast_missing", { cookie })).status).toBe(404);
    expect((await app.api("POST", "/api/assets", { cookie, body: { name: "bad" } })).status).toBe(400);
    expect((await app.api("GET", "/api/assets")).status).toBe(401);

    // A body above the 256kb dashboard cap still reaches WebMCP uploads (1.5 MB of file bytes).
    const big = Buffer.alloc(600_000, 7).toString("base64");
    const large = (await (
      await app.api("POST", "/api/webmcp/tools/studix_upload_asset", {
        cookie,
        body: { name: "big.bin", base64: big, contentType: "application/octet-stream" },
      })
    ).json()) as { structuredContent: Envelope };
    expect(large.structuredContent.status).toBe("ok");
  });

  it("leaves non-JSON bodies to their own route parsers", async () => {
    const cookie = await app.signUp(`zip-${Date.now()}@example.test`);
    // Not a valid archive, but it must reach the skill route's raw parser and fail there, not as a JSON error.
    const res = await fetch(`${app.base}/api/skills/upload`, {
      method: "POST",
      headers: { origin: app.base, cookie, "content-type": "application/zip" },
      body: Buffer.alloc(300_000, 1),
    });
    const body = (await res.json()) as { error?: { code?: string } };
    expect(res.status).not.toBe(413);
    expect(JSON.stringify(body)).not.toContain("entity.");
  });
});
