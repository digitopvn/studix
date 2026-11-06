import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { normalizeRepoPath, parseGitHubUrl } from "../../src/external/index.ts";

describe("parseGitHubUrl", () => {
  it.each([
    ["https://github.com/Owner/repo", { owner: "Owner", repo: "repo", path: "" }],
    ["https://github.com/owner/repo.git", { owner: "owner", repo: "repo", path: "" }],
    ["https://github.com/owner/repo///", { owner: "owner", repo: "repo", path: "" }],
    ["github.com/owner/repo", { owner: "owner", repo: "repo", path: "" }],
    ["  https://GitHub.com/owner/re.po_x-1?tab=readme#top ", { owner: "owner", repo: "re.po_x-1", path: "" }],
    ["https://github.com/o/r/tree/main", { owner: "o", repo: "r", ref: "main", path: "" }],
    ["https://github.com/o/r/tree/v1.2.0/skills/pdf/", { owner: "o", repo: "r", ref: "v1.2.0", path: "skills/pdf" }],
    ["https://github.com/o/r/blob/main/skills/pdf/SKILL.md", { owner: "o", repo: "r", ref: "main", path: "skills/pdf" }],
    ["https://github.com/o/r/blob/main/SKILL.md", { owner: "o", repo: "r", ref: "main", path: "" }],
    ["https://github.com/o/r/tree/main/a%20b", { owner: "o", repo: "r", ref: "main", path: "a b" }],
  ])("accepts %s", (input, expected) => {
    expect(parseGitHubUrl(input)).toEqual({ ref: undefined, ...expected });
  });

  it("takes the first /tree/ segment as the ref unless the caller names a slashed ref", () => {
    const url = "https://github.com/o/r/tree/feature/x/skills/a";
    expect(parseGitHubUrl(url)).toMatchObject({ ref: "feature", path: "x/skills/a" });
    expect(parseGitHubUrl(url, { ref: "feature/x" })).toMatchObject({ ref: "feature/x", path: "skills/a" });
    expect(() => parseGitHubUrl(url, { ref: "release" })).toThrow(/does not match/);
    expect(parseGitHubUrl("https://github.com/o/r", { ref: "dev" })).toMatchObject({ ref: "dev", path: "" });
  });

  it.each([
    "http://github.com/o/r",
    "ftp://github.com/o/r",
    "https://www.github.com/o/r",
    "https://gitHub.com.evil.com/o/r",
    "https://github.com.evil.com/o/r",
    "https://evilgithub.com/o/r",
    "https://api.github.com/repos/o/r",
    "https://raw.githubusercontent.com/o/r/main/SKILL.md",
    "https://140.82.112.3/o/r",
    "https://[::1]/o/r",
    "https://localhost/o/r",
    "https://user:pw@github.com/o/r",
    "https://user@github.com/o/r",
    "https://github.com:443/o/r",
    "https://github.com:8080/o/r",
    "//github.com/o/r",
    "github.com.evil.com/o/r",
    "https://github.com/o",
    "https://github.com/-bad/r",
    "https://github.com/o/r$",
    "https://github.com/o/..",
    "https://github.com/o/r/tree/main/../secret",
    "https://github.com/o/r/tree/main/%2e%2e/secret",
    "https://github.com/o/r/tree/main/a%2Fb",
    "https://github.com/o/r/tree/main/a\\b",
    "https://github.com/o/r/tree/main/a%00b",
    "https://github.com/o/r/tree/main/a\nb",
    "https://github.com/o/r/tree/main//a",
    "https://github.com/o/r/tree/..%2f/x",
    "https://github.com/o/r/tree",
    "https://github.com/o/r/issues/1",
    "https://github.com/o/r/blob/main/README.md",
    "https://github.com/o/r.git/tree/main",
    "https://github.com/o/r/tree/main/%zz",
    "",
  ])("rejects %j", (input) => {
    try {
      parseGitHubUrl(input);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(StudixError);
      expect((err as StudixError).code).toBe("VALIDATION");
      expect((err as StudixError).suggestedAction).toBeTruthy();
    }
  });

  it("rejects an unsafe explicit ref", () => {
    expect(() => parseGitHubUrl("https://github.com/o/r", { ref: "../main" })).toThrow(StudixError);
    expect(() => parseGitHubUrl("https://github.com/o/r", { ref: "-x" })).toThrow(StudixError);
  });
});

describe("normalizeRepoPath", () => {
  it.each([
    ["", ""],
    [".", ""],
    ["skills/pdf/", "skills/pdf"],
    [".claude/skills/a", ".claude/skills/a"],
  ])("normalizes %j", (input, expected) => {
    expect(normalizeRepoPath(input)).toBe(expected);
  });

  it.each(["/etc", "a/../b", "..", "a/./b", "a//b", "a\\b", "a\u0000b", "a\tb", "%2e%2e/x", "x".repeat(1025)])(
    "rejects %j",
    (input) => {
      expect(normalizeRepoPath(input)).toBeUndefined();
    },
  );
});
