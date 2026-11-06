import { isStudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { parseGithubRepositoryUrl } from "../../src/index.ts";

function rejects(url: string): void {
  let error: unknown;
  try {
    parseGithubRepositoryUrl(url);
  } catch (err) {
    error = err;
  }
  expect(isStudixError(error), url).toBe(true);
  expect((error as { code: string }).code).toBe("VALIDATION");
}

describe("parseGithubRepositoryUrl", () => {
  it("accepts bare repository URLs, with or without .git and a trailing slash", () => {
    expect(parseGithubRepositoryUrl("https://github.com/Acme/Skills")).toEqual({
      owner: "Acme",
      repo: "Skills",
      repository: "acme/skills",
    });
    expect(parseGithubRepositoryUrl("https://github.com/acme/skills.git").repo).toBe("skills");
    expect(parseGithubRepositoryUrl("https://github.com/acme/skills/").repository).toBe("acme/skills");
    expect(parseGithubRepositoryUrl("https://GitHub.com/acme/skills#readme").repository).toBe("acme/skills");
  });

  it("keeps the ambiguous ref/path segments of /tree/ URLs", () => {
    expect(
      parseGithubRepositoryUrl("https://github.com/acme/skills/tree/feature/x/skills/pdf").refPath,
    ).toEqual(["feature", "x", "skills", "pdf"]);
    expect(parseGithubRepositoryUrl("https://github.com/acme/skills/tree/main").refPath).toEqual(["main"]);
  });

  it("maps a /blob/ URL of a SKILL.md to its folder", () => {
    expect(
      parseGithubRepositoryUrl("https://github.com/acme/skills/blob/main/skills/pdf/SKILL.md").refPath,
    ).toEqual(["main", "skills", "pdf"]);
    rejects("https://github.com/acme/skills/blob/main/skills/pdf/README.md");
  });

  it.each([
    ["plain http", "http://github.com/acme/skills"],
    ["another host", "https://gitlab.com/acme/skills"],
    ["a look-alike host", "https://github.com.evil.com/acme/skills"],
    ["a raw content host", "https://raw.githubusercontent.com/acme/skills/main/SKILL.md"],
    ["the API host", "https://api.github.com/repos/acme/skills"],
    ["user info", "https://user:pass@github.com/acme/skills"],
    ["user info hiding the real host", "https://github.com@evil.com/acme/skills"],
    ["an explicit port", "https://github.com:443/acme/skills"],
    ["an IPv4 literal", "https://140.82.112.3/acme/skills"],
    ["an IPv6 literal", "https://[::1]/acme/skills"],
    ["localhost", "https://localhost/acme/skills"],
    ["a query string", "https://github.com/acme/skills?redirect=https://evil.com"],
    ["dot-dot traversal", "https://github.com/acme/skills/tree/main/../../../etc"],
    ["encoded traversal", "https://github.com/acme/skills/tree/main/%2e%2e/secret"],
    ["an encoded slash", "https://github.com/acme/skills/tree/main/a%2F..%2Fb"],
    ["a backslash", "https://github.com/acme/skills/tree/main\\..\\x"],
    ["an encoded NUL", "https://github.com/acme/skills/tree/main/a%00b"],
    ["a raw control character", "https://github.com/acme/skills/tree/main/a\u0001b"],
    ["an empty segment", "https://github.com/acme//skills"],
    ["an invalid owner", "https://github.com/-acme/skills"],
    ["an invalid repository name", "https://github.com/acme/sk!lls"],
    ["a missing repository", "https://github.com/acme"],
    ["an unsupported page", "https://github.com/acme/skills/issues/1"],
    ["a tree URL without ref", "https://github.com/acme/skills/tree"],
    ["a broken percent-escape", "https://github.com/acme/skills/tree/main/%zz"],
    ["an over-long URL", `https://github.com/acme/skills/tree/main/${"a/".repeat(1100)}`],
    ["an over-long segment", `https://github.com/acme/skills/tree/main/${"a".repeat(300)}`],
    ["not a URL at all", "acme/skills"],
  ])("rejects %s", (_label, url) => {
    rejects(url);
  });
});
