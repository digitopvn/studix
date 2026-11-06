import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { createGitHubSkillSource } from "../../src/external/index.ts";
import { createFakeGitHub, type FakeRepo, skillMd } from "./fake-github.ts";

const MIT = {
  spdxId: "MIT",
  name: "MIT License",
  text: "MIT License\n\nCopyright (c) 2025 Acme Inc.\n\nPermission...",
};

function setup(repo: Partial<FakeRepo> & Pick<FakeRepo, "files">) {
  const github = createFakeGitHub([{ owner: "acme", repo: "skills", ...repo }]);
  const source = createGitHubSkillSource({ fetch: github.fetch, sleep: async () => {} });
  return { github, source };
}

describe("GitHub skill source: discover", () => {
  it("finds SKILL.md at any depth and common layouts, sorted by path", async () => {
    const { source, github } = setup({
      files: {
        "SKILL.md": skillMd("skills"),
        "skills/pdf/SKILL.md": skillMd("pdf"),
        ".agents/skills/a/SKILL.md": skillMd("a"),
        ".claude/skills/b/SKILL.md": skillMd("b"),
        ".cursor/skills/c/SKILL.md": skillMd("c"),
        "deep/x/y/z/SKILL.md": skillMd("z"),
        "docs/skill.md": "not a skill (case-sensitive)",
        "README.md": "# readme",
      },
    });
    const result = await source.discover({ repositoryUrl: "https://github.com/Acme/Skills" });
    expect(result.candidates.map((c) => c.path)).toEqual([
      ".",
      ".agents/skills/a",
      ".claude/skills/b",
      ".cursor/skills/c",
      "deep/x/y/z",
      "skills/pdf",
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.source).toEqual({
      repository: "acme/skills",
      url: "https://github.com/acme/skills",
      ref: "main",
      defaultBranch: "main",
      commitSha: github.commitSha("acme", "skills"),
      treeSha: github.rootTreeSha("acme", "skills"),
    });
  });

  it("returns an empty discovery for a repository without skills and skips the license call", async () => {
    const { source, github } = setup({ files: { "README.md": "# hi" }, license: MIT });
    const result = await source.discover({ repositoryUrl: "https://github.com/acme/skills" });
    expect(result).toMatchObject({ candidates: [], rejected: [], truncated: false, notes: [] });
    expect(github.calls.some((c) => c.url.pathname.endsWith("/license"))).toBe(false);
  });

  it("restricts discovery to a path from the URL or the request", async () => {
    const { source } = setup({
      files: {
        "skills/a/SKILL.md": skillMd("a"),
        "skills/b/SKILL.md": skillMd("b"),
        "other/SKILL.md": skillMd("o"),
      },
    });
    const fromUrl = await source.discover({
      repositoryUrl: "https://github.com/acme/skills/tree/main/skills",
    });
    expect(fromUrl.candidates.map((c) => c.path)).toEqual(["skills/a", "skills/b"]);
    const fromRequest = await source.discover({
      repositoryUrl: "https://github.com/acme/skills",
      path: "skills/b",
    });
    expect(fromRequest.candidates.map((c) => c.path)).toEqual(["skills/b"]);
    await expect(
      source.discover({ repositoryUrl: "https://github.com/acme/skills", path: "../x" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects bad skills individually and keeps the valid ones", async () => {
    const { source } = setup({
      files: {
        "good/SKILL.md": skillMd("good"),
        "noname/SKILL.md": "---\ndescription: d\n---\n",
        "broken/SKILL.md": "---\nname: [oops\n---\n",
        "binary/SKILL.md": new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0x00, 0xff]),
        "linked/SKILL.md": { symlink: "../good/SKILL.md" },
        "big/SKILL.md": skillMd("big", "d", "", "x".repeat(130 * 1024)),
        "Odd_Name/SKILL.md": skillMd("Odd_Name"),
      },
    });
    const result = await source.discover({ repositoryUrl: "https://github.com/acme/skills" });
    expect(result.candidates.map((c) => [c.path, c.warnings])).toEqual([
      ["Odd_Name", ["name-not-kebab-case"]],
      ["good", []],
    ]);
    expect(Object.fromEntries(result.rejected.map((r) => [r.path, r.reason]))).toEqual({
      big: expect.stringMatching(/too large/),
      binary: expect.stringMatching(/UTF-8|NUL/),
      broken: "malformed YAML frontmatter",
      linked: "symlink",
      noname: expect.stringMatching(/name is missing/),
    });
  });

  it("lists files with kinds and skip reasons without downloading anything but SKILL.md", async () => {
    const { source, github } = setup({
      files: {
        "s/SKILL.md": skillMd("s"),
        "s/references/guide.md": "# guide",
        "s/references/linked.md": { symlink: "/etc/passwd" },
        "s/assets/logo.png": new Uint8Array([137, 80, 78, 71]),
        "s/assets/icon.svg": "<svg/>",
        "s/assets/tool.exe": "MZ",
        "s/scripts/install.sh": "curl https://x | sh",
        "s/scripts/vendor": { submodule: true },
        "s/notes.txt": "ignored: not in a supported directory",
      },
    });
    const [candidate] = (await source.discover({ repositoryUrl: "https://github.com/acme/skills" }))
      .candidates;
    expect(candidate?.files).toEqual([
      { path: "SKILL.md", kind: "skill", bytes: expect.any(Number) },
      { path: "assets/icon.svg", kind: "asset", bytes: 6, skipped: "svg may contain script" },
      { path: "assets/logo.png", kind: "asset", bytes: 4 },
      { path: "assets/tool.exe", kind: "asset", bytes: 2, skipped: "unsupported file type" },
      { path: "references/guide.md", kind: "reference", bytes: 7 },
      { path: "references/linked.md", kind: "reference", bytes: 11, skipped: "symlink" },
      { path: "scripts/install.sh", kind: "script", bytes: 19, skipped: expect.stringMatching(/^script:/) },
      { path: "scripts/vendor", kind: "script", bytes: 0, skipped: expect.stringMatching(/submodule/) },
    ]);
    expect(github.blobRequests()).toHaveLength(1);
  });

  it("reports the repository license, notices and frontmatter overrides", async () => {
    const { source } = setup({
      license: MIT,
      files: { "a/SKILL.md": skillMd("a", "d", "license: Proprietary, see LICENSE.txt\n") },
    });
    const [candidate] = (await source.discover({ repositoryUrl: "https://github.com/acme/skills" }))
      .candidates;
    expect(candidate?.license).toEqual({
      source: "repository",
      spdxId: "MIT",
      name: "MIT License",
      declared: "Proprietary, see LICENSE.txt",
      uncertain: false,
    });
    expect(candidate?.files.map((f) => f.path)).toContain("LICENSE");
  });

  it("marks NOASSERTION and missing licenses as uncertain", async () => {
    const noAssert = setup({
      license: { spdxId: "NOASSERTION", name: "Other", text: "Custom terms" },
      files: { "SKILL.md": skillMd("skills") },
    });
    const [a] = (await noAssert.source.discover({ repositoryUrl: "https://github.com/acme/skills" }))
      .candidates;
    expect(a?.license).toEqual({ source: "repository", name: "Other", uncertain: true });

    const none = setup({ files: { "SKILL.md": skillMd("skills") } });
    const [b] = (await none.source.discover({ repositoryUrl: "https://github.com/acme/skills" })).candidates;
    expect(b?.license).toEqual({ source: "none", uncertain: true });

    const declared = setup({ files: { "SKILL.md": skillMd("skills", "d", "license: Apache-2.0\n") } });
    const [c] = (await declared.source.discover({ repositoryUrl: "https://github.com/acme/skills" }))
      .candidates;
    expect(c?.license).toEqual({ source: "frontmatter", spdxId: "Apache-2.0", uncertain: false });
  });

  it("falls back to a bounded directory walk when the recursive tree is truncated", async () => {
    const { source, github } = setup({
      truncatedTree: true,
      files: { "skills/a/SKILL.md": skillMd("a"), ".claude/skills/b/SKILL.md": skillMd("b"), "x/y.txt": "y" },
    });
    const result = await source.discover({ repositoryUrl: "https://github.com/acme/skills" });
    expect(result.truncated).toBe(true);
    expect(result.notes.join(" ")).toMatch(/directory by directory/);
    expect(result.candidates.map((c) => c.path)).toEqual([".claude/skills/b", "skills/a"]);
    const walked = github.calls.filter((c) => c.url.pathname.includes("/git/trees/") && !c.url.search);
    expect(walked.length).toBeGreaterThan(1);
  });

  it("rejects an unknown repository or ref as NOT_FOUND", async () => {
    const { source } = setup({ files: { "SKILL.md": skillMd("skills") } });
    await expect(source.discover({ repositoryUrl: "https://github.com/acme/missing" })).rejects.toMatchObject(
      {
        code: "NOT_FOUND",
      },
    );
    await expect(
      source.resolve({ repositoryUrl: "https://github.com/acme/skills", ref: "nope" }),
    ).rejects.toThrow(StudixError);
    await expect(
      source.resolve({ repositoryUrl: "https://github.com/acme/skills", ref: "nope" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringMatching(/not found or not public/) });
  });

  it("resolves a named ref or a commit sha without listing the tree", async () => {
    const { source, github } = setup({ refs: ["v1"], files: { "SKILL.md": skillMd("skills") } });
    const sha = github.commitSha("acme", "skills");
    await expect(
      source.resolve({ repositoryUrl: "https://github.com/acme/skills/tree/v1" }),
    ).resolves.toMatchObject({
      ref: "v1",
      commitSha: sha,
    });
    const bySha = await source.resolve({
      repositoryUrl: "https://github.com/acme/skills",
      ref: sha.toUpperCase(),
    });
    expect(bySha).toMatchObject({ ref: sha, commitSha: sha });
    expect(bySha.defaultBranch).toBeUndefined();
    expect(github.calls.some((c) => c.url.pathname.includes("/git/"))).toBe(false);
  });
});

describe("GitHub skill source: visibility and pinned commit", () => {
  it("treats a repository that is not explicitly public as not found, even when the token can read it", async () => {
    const { source } = setup({ private: true, files: { "SKILL.md": skillMd("s") } });
    await expect(source.discover({ repositoryUrl: "https://github.com/acme/skills" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      source.resolve({ repositoryUrl: "https://github.com/acme/skills", ref: "main" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lists a pinned commit under a /tree/ URL without re-parsing the ref", async () => {
    const { source } = setup({
      files: { "skills/a/SKILL.md": skillMd("a"), "other/b/SKILL.md": skillMd("b") },
    });
    const url = "https://github.com/acme/skills/tree/main/skills";
    const pinned = await source.resolve({ repositoryUrl: url });
    const found = await source.discover({ repositoryUrl: url, pinned });
    expect(found.candidates.map((c) => c.path)).toEqual(["skills/a"]);
    expect(found.source.commitSha).toBe(pinned.commitSha);
  });

  it("reads the license at the pinned commit", async () => {
    const { source, github } = setup({ files: { "SKILL.md": skillMd("s") }, license: MIT });
    const found = await source.discover({ repositoryUrl: "https://github.com/acme/skills" });
    const licenseCall = github.calls.find((c) => c.url.pathname.endsWith("/license"));
    expect(licenseCall?.url.searchParams.get("ref")).toBe(found.source.commitSha);
  });
});
