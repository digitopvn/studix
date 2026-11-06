import { StudixError, systemClock } from "@studix/shared";
import { describe, expect, it } from "vitest";
import type {
  ExternalSkillSource,
  FetchedSkill,
  FetchSkillsResult,
  PinnedSource,
} from "../src/entities/index.ts";
import type { StorageAdapter, StoredObject } from "../src/ports/storage-adapter.ts";
import { createExternalSkillService } from "../src/studio/external-skill-service.ts";
import { createInMemoryExternalSkillRepository, testTenant } from "../src/testing/index.ts";

const COMMIT = "a".repeat(40);

function pinned(repository: string, commitSha = COMMIT): PinnedSource {
  return {
    repository,
    url: `https://github.com/${repository}`,
    ref: "main",
    commitSha,
    treeSha: "b".repeat(40),
  };
}

function fetched(path: string, name: string, body: string): FetchedSkill {
  const content = new TextEncoder().encode(body);
  return {
    path,
    name,
    description: `${name} description`,
    frontmatter: { name },
    files: [
      {
        path: "SKILL.md",
        kind: "skill",
        bytes: content.length,
        sha256: `sha-${body}`,
        contentType: "text/markdown",
        content,
      },
    ],
    license: { source: "none", uncertain: true },
    notices: [],
    warnings: [],
  };
}

function memoryStorage(): Pick<StorageAdapter, "put" | "get"> {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(_ctx, key, body) {
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : (body as Uint8Array);
      objects.set(key, bytes);
      return { key, bytes: bytes.length } as unknown as StoredObject;
    },
    async get(_ctx, key) {
      const found = objects.get(key);
      if (!found) throw new StudixError("NOT_FOUND", "no such object");
      return {
        body: new Blob([found as BlobPart]).stream(),
        contentType: "text/markdown",
        bytes: found.length,
      };
    },
  };
}

function setup(options: { storage?: boolean; skills?: Record<string, FetchSkillsResult> } = {}) {
  const repository = "acme/skills";
  const results: Record<string, FetchSkillsResult> = options.skills ?? {
    "a/one": { path: "a/one", status: "ok", skill: fetched("a/one", "shared-name", "one") },
    "b/two": { path: "b/two", status: "ok", skill: fetched("b/two", "shared-name", "two") },
    "c/bad": { path: "c/bad", status: "rejected", code: "invalid", reason: "bad frontmatter" },
  };
  const source: ExternalSkillSource = {
    async resolve({ repositoryUrl, ref }) {
      if (!repositoryUrl.includes(repository) || ref?.startsWith("nope"))
        throw new StudixError("NOT_FOUND", "no such repository");
      return pinned(repository);
    },
    async discover() {
      return { source: pinned(repository), candidates: [], rejected: [], truncated: false, notes: [] };
    },
    async fetchSkills(_source, paths) {
      return paths.map(
        (p) =>
          results[p] ?? ({ path: p, status: "rejected", code: "missing", reason: "no SKILL.md" } as const),
      );
    },
  };
  const service = createExternalSkillService({
    skills: createInMemoryExternalSkillRepository(systemClock),
    source,
    ...(options.storage === false ? {} : { storage: memoryStorage() }),
  });
  return { service, ctx: testTenant({ role: "editor" }), repositoryUrl: `https://github.com/${repository}` };
}

describe("ExternalSkillService", () => {
  it("imports good skills, rejects the bad one and reports name collisions", async () => {
    const { service, ctx, repositoryUrl } = setup();
    const res = await service.import(ctx, { repositoryUrl, skillPaths: ["a/one", "b/two", "c/bad"] });
    expect(res.results.map((r) => r.status)).toEqual(["imported", "imported", "rejected"]);
    const second = res.results[1];
    expect(second?.status === "imported" ? second.nameCollisions : undefined).toHaveLength(1);
    const again = await service.import(ctx, { repositoryUrl, skillPaths: ["a/one"] });
    expect(again.results[0]?.status).toBe("unchanged");
  });

  it("fails with CONFLICT when the repository moved past expectedCommit", async () => {
    const { service, ctx, repositoryUrl } = setup();
    await expect(
      service.import(ctx, { repositoryUrl, all: true, expectedCommit: "c".repeat(40) }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("answers UNAVAILABLE for imports without object storage", async () => {
    const { service, ctx, repositoryUrl } = setup({ storage: false });
    await expect(service.import(ctx, { repositoryUrl, skillPaths: ["a/one"] })).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });

  it("withholds content of a disabled skill and requires write permission to change it", async () => {
    const { service, ctx, repositoryUrl } = setup();
    const res = await service.import(ctx, { repositoryUrl, skillPaths: ["a/one"] });
    const first = res.results[0];
    if (first?.status === "rejected" || !first) throw new Error("import failed");
    await service.disable(ctx, { skillId: first.skillId });
    const got = await service.get(ctx, { skillId: first.skillId });
    expect(got.content).toBeNull();
    const viewer = { ...ctx, actor: { ...ctx.actor, role: "viewer" as const } };
    await expect(service.disable(viewer, { skillId: first.skillId, enable: true })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("marks a skill missing when the upstream repository disappears", async () => {
    const { service, ctx, repositoryUrl } = setup();
    const res = await service.import(ctx, { repositoryUrl, skillPaths: ["a/one"] });
    const first = res.results[0];
    if (first?.status === "rejected" || !first) throw new Error("import failed");
    const gone = createExternalSkillService({
      skills: (service as unknown as { deps: { skills: never } }).deps.skills,
      source: {
        resolve: async () => {
          throw new StudixError("NOT_FOUND", "gone");
        },
        discover: async () => {
          throw new Error("unused");
        },
        fetchSkills: async () => [],
      },
    });
    const check = await gone.update(ctx, { skillId: first.skillId, action: "check" });
    expect("upstream" in check ? check.upstream : undefined).toBe("missing");
  });

  it("does not mark a skill missing because the caller typed an unknown ref", async () => {
    const { service, ctx, repositoryUrl } = setup();
    const res = await service.import(ctx, { repositoryUrl, skillPaths: ["a/one"] });
    const first = res.results[0];
    if (first?.status === "rejected" || !first) throw new Error("import failed");
    await expect(
      service.update(ctx, { skillId: first.skillId, action: "check", ref: "nope/not-here" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [listed] = (await service.list(ctx, {})).items;
    expect(listed?.upstreamStatus).toBe("unknown");
  });

  it("pages multibyte text without cutting a character", async () => {
    const text = "Xin chào ".repeat(40) + "日本語のスキル。".repeat(60);
    const { service, ctx, repositoryUrl } = setup({
      skills: { "a/one": { path: "a/one", status: "ok", skill: fetched("a/one", "multi", text) } },
    });
    const res = await service.import(ctx, { repositoryUrl, skillPaths: ["a/one"] });
    const first = res.results[0];
    if (first?.status === "rejected" || !first) throw new Error("import failed");
    let offset = 0;
    let joined = "";
    for (let i = 0; i < 2000; i++) {
      const page = await service.get(ctx, { skillId: first.skillId, offset, maxBytes: 7 });
      joined += page.content ?? "";
      if (!("nextOffset" in page) || page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(joined).toBe(text);
  });

  it("limits concurrent GitHub operations per workspace", async () => {
    const { service, ctx, repositoryUrl } = setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = createExternalSkillService({
      skills: createInMemoryExternalSkillRepository(systemClock),
      source: {
        resolve: async () => pinned("acme/skills"),
        discover: async () => {
          await gate;
          return { source: pinned("acme/skills"), candidates: [], rejected: [], truncated: false, notes: [] };
        },
        fetchSkills: async () => [],
      },
    });
    const running = [slow.discover(ctx, { repositoryUrl }), slow.discover(ctx, { repositoryUrl })];
    await expect(slow.discover(ctx, { repositoryUrl })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    release();
    await Promise.all(running);
    await expect(slow.discover(ctx, { repositoryUrl })).resolves.toBeDefined();
    expect(service).toBeDefined();
  });
});
