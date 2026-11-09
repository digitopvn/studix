import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type CompositionFile,
  compositionFileKey,
  createCompositionService,
  type StorageAdapter,
  saveCompositionManifest,
} from "../src/index.ts";
import { createInMemoryStudio, testTenant } from "../src/testing/index.ts";

type Storage = Pick<StorageAdapter, "get" | "head" | "put" | "delete" | "signedUrl">;

function fakeStorage() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const storage: Storage = {
    async put(_ctx, key, body, options) {
      const bytes =
        body instanceof Uint8Array
          ? body
          : new Uint8Array(await new Response(body as ReadableStream).arrayBuffer());
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (options.sha256 && options.sha256 !== sha256) throw new Error("sha mismatch");
      objects.set(key, { bytes, contentType: options.contentType });
      return { key, bytes: bytes.byteLength, sha256, contentType: options.contentType };
    },
    async get(_ctx, key) {
      const o = objects.get(key);
      if (!o) throw new Error("missing");
      return {
        body: new Response(Buffer.from(o.bytes)).body as ReadableStream<Uint8Array>,
        contentType: o.contentType,
        bytes: o.bytes.byteLength,
      };
    },
    async head(_ctx, key) {
      const o = objects.get(key);
      return o ? { key, bytes: o.bytes.byteLength, sha256: "", contentType: o.contentType } : undefined;
    },
    async delete(_ctx, key) {
      objects.delete(key);
    },
    async signedUrl(_ctx, key) {
      return `https://signed.test/${key}`;
    },
  };
  return { storage, objects };
}

async function setup() {
  const env = createInMemoryStudio({});
  const ctx = testTenant();
  const { storage, objects } = fakeStorage();
  const { project } = await env.studio.createVideoProject(ctx, { brief: { prompt: "Brand intro" } });
  const mp4 = new TextEncoder().encode("not-really-an-mp4");
  const sha256 = createHash("sha256").update(mp4).digest("hex");
  const file: CompositionFile = {
    path: "out/video.mp4",
    bytes: mp4.byteLength,
    sha256,
    contentType: "video/mp4",
  };
  const notes: CompositionFile = { path: "notes.txt", bytes: 1, sha256: "x", contentType: "text/plain" };
  await storage.put(ctx, compositionFileKey("cmp_abcdef", file.path), mp4, { contentType: "video/mp4" });
  await saveCompositionManifest(storage, ctx, {
    id: "cmp_abcdef",
    files: [file, notes],
    updatedAt: new Date().toISOString(),
  });
  const service = createCompositionService({
    storage,
    queue: env.repos.queue,
    projects: env.repos.projects,
    renders: env.repos.renders,
    assets: env.repos.assets,
    audit: env.repos.audit,
    defaults: { jobBudgetCents: 0 },
  });
  return { env, ctx, project, service, objects };
}

describe("attaching a composition render to a project", () => {
  it("stores a playable render with an asset version and replays idempotently", async () => {
    const { env, ctx, project, service, objects } = await setup();
    await env.repos.projects.update(ctx, project.id, { currentVersionId: "pver_current" });
    const input = { compositionId: "cmp_abcdef", path: "out/video.mp4", projectId: project.id };

    const first = await service.attachRender(ctx, input);
    expect(first.replayed).toBe(false);
    expect(first.render).toMatchObject({
      projectId: project.id,
      versionId: "pver_current",
      status: "succeeded",
      preset: "final",
    });
    expect(objects.has(first.render.storageKey as string)).toBe(true);
    const version = await env.repos.assets.getVersion(ctx, first.render.assetVersionId as string);
    expect(version).toMatchObject({
      assetId: first.assetId,
      storageKey: first.render.storageKey,
      mime: "video/mp4",
    });
    const listed = await env.repos.renders.listByProject(ctx, project.id);
    expect(listed.items.map((r) => r.id)).toEqual([first.render.id]);

    const again = await service.attachRender(ctx, input);
    expect(again.replayed).toBe(true);
    expect(again.render.id).toBe(first.render.id);
    expect(again.assetId).toBe(first.assetId);
    expect((await env.repos.renders.listByProject(ctx, project.id)).items).toHaveLength(1);
  });

  it("refuses a project without a version, a missing file and a non-MP4", async () => {
    const { env, ctx, project, service } = await setup();
    const base = { compositionId: "cmp_abcdef", projectId: project.id };
    await expect(service.attachRender(ctx, { ...base, path: "out/video.mp4" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await env.repos.projects.update(ctx, project.id, { currentVersionId: "pver_current" });
    await expect(service.attachRender(ctx, { ...base, path: "out/none.mp4" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(service.attachRender(ctx, { ...base, path: "notes.txt" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("does not see another tenant's project", async () => {
    const { ctx, project, service } = await setup();
    const other = testTenant({ workspaceId: "ws_other" });
    await expect(
      service.attachRender(other, {
        compositionId: "cmp_abcdef",
        path: "out/video.mp4",
        projectId: project.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    void ctx;
  });
});
