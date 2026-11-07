import { describe, expect, it } from "vitest";
import { normalizeSkillPath, parseGitHubUrl, sourceKeyOf } from "../../src/external/github-url.ts";

describe("parseGitHubUrl", () => {
  it("reads owner and repo from a plain repository URL", () => {
    expect(parseGitHubUrl("https://github.com/anthropics/skills")).toEqual({
      owner: "anthropics",
      repo: "skills",
      isBlob: false,
    });
    expect(parseGitHubUrl(" https://www.github.com/a/b.git/ ").repo).toBe("b");
  });

  it("keeps the ref-and-path tail of tree and blob URLs", () => {
    expect(parseGitHubUrl("https://github.com/o/r/tree/feature/x/skills/pdf")).toMatchObject({
      refAndPath: ["feature", "x", "skills", "pdf"],
      isBlob: false,
    });
    expect(parseGitHubUrl("https://github.com/o/r/blob/main/skills/pdf/SKILL.md").isBlob).toBe(true);
  });

  it.each([
    "http://github.com/o/r",
    "https://gitlab.com/o/r",
    "https://github.com.evil.test/o/r",
    "https://evil.test/github.com/o/r",
    "https://user:pw@github.com/o/r",
    "https://github.com:8443/o/r",
    "https://github.com/o",
    "https://github.com/o/r/issues/1",
    "https://github.com/o/r/tree",
    "https://github.com/o/r/tree/main/../../etc",
    "https://github.com/-bad-/r",
    "https://127.0.0.1/o/r",
    "https://169.254.169.254/latest/meta-data",
    "git@github.com:o/r.git",
    "file:///etc/passwd",
    "",
  ])("rejects %s", (input) => {
    expect(() => parseGitHubUrl(input)).toThrow(/URL|GitHub|owner|ref|path|https/i);
  });
});

describe("normalizeSkillPath", () => {
  it("normalizes directories and strips a trailing SKILL.md", () => {
    expect(normalizeSkillPath(undefined)).toBe("");
    expect(normalizeSkillPath("/")).toBe("");
    expect(normalizeSkillPath("skills/pdf/")).toBe("skills/pdf");
    expect(normalizeSkillPath("skills/pdf/SKILL.md")).toBe("skills/pdf");
    expect(normalizeSkillPath("SKILL.md")).toBe("");
  });

  it.each(["../x", "a/../b", "a//b", "a\\b", "a/./b", "a\u0000b"])("rejects %j", (input) => {
    expect(() => normalizeSkillPath(input)).toThrow("Unsafe skill path");
  });
});

describe("sourceKeyOf", () => {
  it("lower-cases owner and repo and marks the root", () => {
    expect(sourceKeyOf("Anthropics", "Skills", "")).toBe("github.com/anthropics/skills/.");
    expect(sourceKeyOf("o", "r", "skills/Pdf")).toBe("github.com/o/r/skills/Pdf");
  });
});
