import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { createAssetService } from "../src/studio/asset-service.ts";
import { createInMemoryStudio, testTenant } from "../src/testing/index.ts";

const b64 = (text: string) => Buffer.from(text).toString("base64");

async function rejects(promise: Promise<unknown>): Promise<StudixError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof StudixError) return err;
    throw err;
  }
  throw new Error("expected a StudixError");
}

function setup(options: { fetchUrl?: boolean } = {}) {
  const env = createInMemoryStudio();
  const objects = new Map<string, Uint8Array>();
  const service = createAssetService({
    assets: env.repos.assets,
    projects: env.repos.projects,
    audit: env.repos.audit,
    revisions: env.repos.revisions,
    storage: {
      async put(ctx, key, body, opts) {
        const bytes = body as Uint8Array;
        objects.set(`${ctx.workspaceId}/${key}`, bytes);
        return { key, bytes: bytes.byteLength, sha256: opts.sha256 ?? "", contentType: opts.contentType };
      },
      async signedUrl(ctx, key) {
        return `https://files.test/${ctx.workspaceId}/${key}?sig=1`;
      },
    },
    ...(options.fetchUrl
      ? {
          fetchUrl: async (url: string) => ({
            body: new TextEncoder().encode(`from ${url}`),
            contentType: "audio/mpeg",
          }),
        }
      : {}),
  });
  return { ...env, service, objects, ctx: testTenant() };
}

describe("asset service", () => {
  it("uploads a file, infers its kind and signs a URL", async () => {
    const { service, ctx, objects } = setup();
    const out = await service.upload(ctx, { name: "Logo Final.png", base64: b64("png-bytes") });
    expect(out).toMatchObject({ version: 1, unchanged: false });
    expect(out.asset).toMatchObject({
      name: "Logo Final.png",
      kind: "image",
      mime: "image/png",
      versions: 1,
    });
    expect(out.url).toContain("https://files.test/");
    expect([...objects.keys()][0]).toMatch(/\/assets\/ast_[^/]+\/astv_[^/]+\/Logo_Final\.png$/);
  });

  it("adds a version, and ignores identical bytes", async () => {
    const { service, ctx } = setup();
    const first = await service.upload(ctx, { name: "vo.wav", base64: b64("take-1") });
    const same = await service.upload(ctx, { assetId: first.asset.id, base64: b64("take-1") });
    expect(same).toMatchObject({ unchanged: true, version: 1 });
    const next = await service.upload(ctx, { assetId: first.asset.id, base64: b64("take-2") });
    expect(next).toMatchObject({ unchanged: false, version: 2 });
    const details = await service.get(ctx, { assetId: first.asset.id });
    expect(details.versions.map((v) => [v.version, v.current])).toEqual([
      [2, true],
      [1, false],
    ]);
  });

  it("imports from a URL when the server can fetch", async () => {
    const { service, ctx } = setup({ fetchUrl: true });
    const out = await service.upload(ctx, { url: "https://cdn.example.com/a/theme.mp3" });
    expect(out.asset).toMatchObject({ name: "theme.mp3", kind: "audio", mime: "audio/mpeg" });
    const details = await service.get(ctx, { assetId: out.asset.id });
    expect(details.versions[0]).toMatchObject({ source: "external" });
    const none = setup();
    expect(
      (await rejects(none.service.upload(none.ctx, { url: "https://cdn.example.com/x.png" }))).code,
    ).toBe("UNAVAILABLE");
  });

  it("validates uploads", async () => {
    const { service, ctx } = setup();
    expect((await rejects(service.upload(ctx, { name: "a.png" }))).code).toBe("VALIDATION");
    expect((await rejects(service.upload(ctx, { name: "a.png", base64: "%%%" }))).code).toBe("VALIDATION");
    expect((await rejects(service.upload(ctx, { base64: b64("x") }))).code).toBe("VALIDATION");
    expect(
      (await rejects(service.upload(ctx, { name: "a.png", base64: b64("x"), projectId: "prj_none" }))).code,
    ).toBe("NOT_FOUND");
  });

  it("lists with filters and hides the trash", async () => {
    const { service, studio, ctx } = setup();
    const { project } = await studio.createVideoProject(ctx, { brief: { prompt: "Intro" } });
    const logo = await service.upload(ctx, { name: "logo.png", base64: b64("1"), projectId: project.id });
    await service.upload(ctx, { name: "theme.mp3", base64: b64("2") });
    expect((await service.list(ctx)).items).toHaveLength(2);
    expect((await service.list(ctx, { kind: "audio" })).items.map((a) => a.name)).toEqual(["theme.mp3"]);
    expect((await service.list(ctx, { q: "LOG" })).items.map((a) => a.name)).toEqual(["logo.png"]);
    expect((await service.list(ctx, { projectId: project.id })).items.map((a) => a.id)).toEqual([
      logo.asset.id,
    ]);
    await service.setDeleted(ctx, logo.asset.id, true);
    expect((await service.list(ctx)).items.map((a) => a.name)).toEqual(["theme.mp3"]);
    expect((await service.list(ctx, { state: "deleted" })).items.map((a) => a.name)).toEqual(["logo.png"]);
    expect((await service.list(ctx, { state: "all" })).items).toHaveLength(2);
  });

  it("renames, moves and detaches", async () => {
    const { service, studio, ctx } = setup();
    const { project } = await studio.createVideoProject(ctx, { brief: { prompt: "Intro" } });
    const a = await service.upload(ctx, { name: "a.png", base64: b64("1") });
    const moved = await service.update(ctx, { assetId: a.asset.id, name: "hero.png", projectId: project.id });
    expect(moved).toMatchObject({ name: "hero.png", projectId: project.id });
    const detached = await service.update(ctx, { assetId: a.asset.id, projectId: null });
    expect(detached.projectId).toBeUndefined();
    expect((await rejects(service.update(ctx, { assetId: a.asset.id }))).code).toBe("VALIDATION");
    expect((await rejects(service.update(ctx, { assetId: a.asset.id, projectId: "prj_none" }))).code).toBe(
      "NOT_FOUND",
    );
  });

  it("trashes and restores; a trashed asset takes no new version", async () => {
    const { service, repos, ctx } = setup();
    const a = await service.upload(ctx, { name: "a.png", base64: b64("1") });
    const trashed = await service.setDeleted(ctx, a.asset.id, true);
    expect(trashed.deletedAt).toBeDefined();
    const again = await service.setDeleted(ctx, a.asset.id, true);
    expect(again.deletedAt).toBe(trashed.deletedAt);
    expect((await rejects(service.upload(ctx, { assetId: a.asset.id, base64: b64("2") }))).code).toBe(
      "CONFLICT",
    );
    const restored = await service.setDeleted(ctx, a.asset.id, false);
    expect(restored.deletedAt).toBeUndefined();
    expect((await service.upload(ctx, { assetId: a.asset.id, base64: b64("2") })).version).toBe(2);
    const actions = (await repos.audit.list(ctx, { subjectId: a.asset.id })).items.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["asset.uploaded", "asset.deleted", "asset.restored", "asset.version_added"]),
    );
    expect(actions.filter((x) => x === "asset.deleted")).toHaveLength(1);
  });

  it("shows lineage in both directions", async () => {
    const { service, ctx } = setup();
    const source = await service.upload(ctx, { name: "src.png", base64: b64("src") });
    const derived = await service.upload(ctx, {
      name: "out.png",
      base64: b64("out"),
      derivedFrom: [source.versionId],
    });
    const out = await service.get(ctx, { assetId: derived.asset.id });
    expect(out.lineage.derivedFrom).toEqual([
      expect.objectContaining({ versionId: source.versionId, assetId: source.asset.id, name: "src.png" }),
    ]);
    const src = await service.get(ctx, { assetId: source.asset.id });
    expect(src.lineage.derivatives).toEqual([
      { assetId: derived.asset.id, versionId: derived.versionId, version: 1 },
    ]);
    expect(
      (await rejects(service.upload(ctx, { name: "x.png", base64: b64("x"), derivedFrom: ["astv_none"] })))
        .code,
    ).toBe("NOT_FOUND");
  });

  it("signs another version on request", async () => {
    const { service, ctx } = setup();
    const v1 = await service.upload(ctx, { name: "a.png", base64: b64("1") });
    await service.upload(ctx, { assetId: v1.asset.id, base64: b64("2") });
    const old = await service.get(ctx, { assetId: v1.asset.id, versionId: v1.versionId });
    expect(old.versionId).toBe(v1.versionId);
    expect(old.url).toContain(`/${v1.versionId}/`);
    expect((await rejects(service.get(ctx, { assetId: v1.asset.id, versionId: "astv_none" }))).code).toBe(
      "NOT_FOUND",
    );
  });

  it("keeps workspaces apart", async () => {
    const { service, ctx } = setup();
    const mine = await service.upload(ctx, { name: "a.png", base64: b64("1") });
    const other = testTenant({ organizationId: ctx.organizationId });
    expect((await service.list(other)).items).toEqual([]);
    for (const call of [
      () => service.get(other, { assetId: mine.asset.id }),
      () => service.update(other, { assetId: mine.asset.id, name: "stolen" }),
      () => service.setDeleted(other, mine.asset.id, true),
      () => service.upload(other, { assetId: mine.asset.id, base64: b64("2") }),
    ]) {
      expect((await rejects(call())).code).toBe("NOT_FOUND");
    }
    expect((await service.get(ctx, { assetId: mine.asset.id })).asset.name).toBe("a.png");
  });

  it("enforces asset:read and asset:write", async () => {
    const { service, ctx } = setup();
    const a = await service.upload(ctx, { name: "a.png", base64: b64("1") });
    const viewer = { ...ctx, actor: { type: "user" as const, id: "usr_v", role: "viewer" as const } };
    expect((await service.list(viewer)).items).toHaveLength(1);
    expect((await rejects(service.upload(viewer, { name: "b.png", base64: b64("2") }))).code).toBe(
      "FORBIDDEN",
    );
    expect((await rejects(service.update(viewer, { assetId: a.asset.id, name: "z" }))).code).toBe(
      "FORBIDDEN",
    );
    expect((await rejects(service.setDeleted(viewer, a.asset.id, true))).code).toBe("FORBIDDEN");
    const noRead = {
      ...ctx,
      actor: { type: "apiKey" as const, id: "key_1", scopes: ["asset:write" as const] },
    };
    expect((await rejects(service.list(noRead))).code).toBe("FORBIDDEN");
  });
});
