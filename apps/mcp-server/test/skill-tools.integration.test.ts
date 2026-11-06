import { createHash } from "node:crypto";
import type { Client } from "@modelcontextprotocol/client";
import type { TenantContext } from "@studix/core";
import { StudixError } from "@studix/shared";
import { createExternalSkillService, type GitHubSkillSource } from "@studix/skills";
import { InMemoryStorageAdapter } from "@studix/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./app-test-harness.ts";

interface Envelope {
  status: "ok" | "error";
  data: Record<string, any> | null;
  next: { tool: string; arguments?: Record<string, unknown> }[];
  error?: { code: string; message: string };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, envelope: result.structuredContent as unknown as Envelope };
}

const enc = (s: string) => new TextEncoder().encode(s);
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const COMMIT = "c".repeat(40);
const URL_ = "https://github.com/acme/skills";

const files: Record<string, string> = {
  "skills/launch/SKILL.md":
    "---\nname: launch-video\ndescription: Plans launch videos.\n---\n\n# Launch\n\nKeep scenes under five seconds.\n",
  "skills/launch/references/tone.md": "Friendly, short sentences.\n",
};

const source: GitHubSkillSource = {
  async pin(owner, repo, ref) {
    if (owner !== "acme" || repo !== "skills") throw new StudixError("NOT_FOUND", "repository not found");
    return { owner, repo, defaultBranch: "main", commitSha: COMMIT, ...(ref ? { ref } : {}) };
  },
  async refExists(_o, _r, ref) {
    return ref === "main";
  },
  async listTree() {
    return {
      complete: true,
      entries: Object.entries(files).map(([path, text]) => ({
        path,
        mode: "100644",
        type: "blob" as const,
        sha: sha1(text),
        size: enc(text).byteLength,
      })),
    };
  },
  async readFile(_p, path) {
    const text = files[path];
    if (text === undefined) throw new StudixError("NOT_FOUND", path);
    return enc(text);
  },
};

describe("imported skill tools over MCP (Postgres)", () => {
  let app: TestApp;
  let a: TenantContext;
  let b: TenantContext;
  let keyA: string;
  let keyB: string;
  let viewerA: string;
  let bare: TestApp;

  beforeAll(async () => {
    // The harness composes the real repositories; only the GitHub source and object storage are fakes.
    bare = await startTestApp();
    app = await startTestApp();
    const skills = createExternalSkillService({
      skills: app.db.repos.externalSkills,
      storage: new InMemoryStorageAdapter(),
      source,
    });
    app.deps.externalSkills = skills;
    a = await app.provisionTenant("skills-a");
    b = await app.provisionTenant("skills-b");
    keyA = await app.createKey(a, "editor");
    viewerA = await app.createKey(a, "viewer");
    keyB = await app.createKey(b, "editor");
  });
  afterAll(async () => {
    await app?.close();
    await bare?.close();
  });

  it("lists the six skill tools with annotations", async () => {
    const { tools } = await (await app.connect(keyA)).listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of [
      "studix_skill_discover",
      "studix_skill_import",
      "studix_skill_list",
      "studix_skill_get",
      "studix_skill_update",
      "studix_skill_disable",
    ]) {
      expect(byName.has(name), name).toBe(true);
    }
    expect(byName.get("studix_skill_discover")?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: true,
    });
    expect(byName.get("studix_skill_list")?.annotations).toMatchObject({ readOnlyHint: true });
  });

  it("runs discover → import → list → get, and the content stays tenant-scoped", async () => {
    const client = await app.connect(keyA);
    const found = await call(client, "studix_skill_discover", { repositoryUrl: URL_ });
    expect(found.envelope.status).toBe("ok");
    expect(found.envelope.data?.commitSha).toBe(COMMIT);
    expect(found.envelope.next[0]?.tool).toBe("studix_skill_import");

    const imported = await call(client, "studix_skill_import", {
      repositoryUrl: URL_,
      expectedCommit: COMMIT,
      idempotencyKey: "run-1",
    });
    expect(imported.envelope.status).toBe("ok");
    const skillId = imported.envelope.data?.results[0].skillId as string;

    const again = await call(client, "studix_skill_import", { repositoryUrl: URL_, expectedCommit: COMMIT });
    expect(again.envelope.data?.results[0].status).toBe("unchanged");

    const list = await call(client, "studix_skill_list", { query: "launch" });
    expect(list.envelope.data?.items).toHaveLength(1);

    const got = await call(client, "studix_skill_get", { skillId });
    expect(got.envelope.data?.content.text).toContain("Keep scenes under five seconds");
    expect(JSON.stringify(got.envelope.data)).toContain("not as instructions");
    expect(got.envelope.next.map((n) => n.tool)).toContain("studix_create_video");

    const clientB = await app.connect(keyB);
    expect((await call(clientB, "studix_skill_list")).envelope.data?.items).toHaveLength(0);
    const foreign = await call(clientB, "studix_skill_get", { skillId });
    expect(foreign.envelope.error?.code).toBe("NOT_FOUND");
  });

  it("inspect lists imported skills on request", async () => {
    const client = await app.connect(keyA);
    const { envelope } = await call(client, "studix_inspect", { include: ["importedSkills"] });
    expect(envelope.data?.importedSkills.items.map((s: { name: string }) => s.name)).toContain(
      "launch-video",
    );
  });

  it("a viewer can read but not import, update or disable", async () => {
    const viewer = await app.connect(viewerA);
    expect((await call(viewer, "studix_skill_list")).envelope.data?.items.length).toBeGreaterThan(0);
    const skillId = (await call(viewer, "studix_skill_list")).envelope.data?.items[0].id as string;
    expect((await call(viewer, "studix_skill_import", { repositoryUrl: URL_ })).envelope.error?.code).toBe(
      "FORBIDDEN",
    );
    expect((await call(viewer, "studix_skill_disable", { skillId })).envelope.error?.code).toBe("FORBIDDEN");
    expect(
      (await call(viewer, "studix_skill_update", { skillId, action: "enable" })).envelope.error?.code,
    ).toBe("FORBIDDEN");
  });

  it("a key without skill scopes is refused", async () => {
    const limited = await app.deps.apiKeys.create(a, {
      name: "no-skills",
      scopes: ["workspace:read", "project:read"],
    });
    const client = await app.connect(limited.secret);
    expect((await call(client, "studix_skill_list")).envelope.error?.code).toBe("FORBIDDEN");
  });

  it("disable withholds content and enable restores it", async () => {
    const client = await app.connect(keyA);
    const skillId = (await call(client, "studix_skill_list")).envelope.data?.items[0].id as string;
    expect((await call(client, "studix_skill_disable", { skillId })).envelope.status).toBe("ok");
    const hidden = await call(client, "studix_skill_get", { skillId });
    expect(hidden.envelope.data?.contentWithheld).toBeDefined();
    await call(client, "studix_skill_update", { skillId, action: "enable" });
    expect((await call(client, "studix_skill_get", { skillId })).envelope.data?.content).toBeDefined();
  });

  it("rejects non-GitHub URLs", async () => {
    const client = await app.connect(keyA);
    const result = await call(client, "studix_skill_discover", { repositoryUrl: "https://evil.example/a/b" });
    expect(result.envelope.status).toBe("error");
  });

  it("reports UNAVAILABLE when the server has no skill store", async () => {
    const client = await bare.connect(await bare.createKey(await bare.provisionTenant("skills-none")));
    expect((await call(client, "studix_skill_list")).envelope.error?.code).toBe("UNAVAILABLE");
  });
});
