import { createHash } from "node:crypto";
import type {
  ExternalSkillSource,
  SkillCandidate,
  SkillDiscoverRequest,
  SkillDiscovery,
  SkillFetchRequest,
  SkillFetchResult,
} from "@studix/core";
import { StudixError } from "@studix/shared";

export interface FakeSkillFile {
  path: string;
  kind: "skill" | "reference" | "asset" | "script";
  content: string;
}

export interface FakeSkill {
  name: string;
  description: string;
  files: FakeSkillFile[];
}

interface FakeRepository {
  commitSha: string;
  skills: Map<string, FakeSkill>;
  invalid: Map<string, string>;
}

const REPOSITORY_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Build a fake skill: the SKILL.md (frontmatter plus body) and any supporting files. */
export function fakeSkill(
  name: string,
  body: string,
  extra: FakeSkillFile[] = [],
  description = `${name} guidance`,
): FakeSkill {
  return {
    name,
    description,
    files: [
      {
        path: "SKILL.md",
        kind: "skill",
        content: `---\nname: ${name}\ndescription: ${description}\n---\n${body}`,
      },
      ...extra,
    ],
  };
}

/**
 * In-memory stand-in for GitHub: repositories and their commits are set by the test and nothing touches
 * the network. `calls` counts how often the store reached out, so tests can assert reads stay local.
 */
export class FakeSkillSource implements ExternalSkillSource {
  private readonly repositories = new Map<string, FakeRepository>();
  readonly calls = { discover: 0, fetch: 0 };

  set(
    repository: string,
    commitSha: string,
    skills: Record<string, FakeSkill>,
    invalid: Record<string, string> = {},
  ): void {
    this.repositories.set(repository.toLowerCase(), {
      commitSha,
      skills: new Map(Object.entries(skills)),
      invalid: new Map(Object.entries(invalid)),
    });
  }

  remove(repository: string): void {
    this.repositories.delete(repository.toLowerCase());
  }

  private lookup(repositoryUrl: string): { name: string; repo: FakeRepository } {
    const match = REPOSITORY_URL.exec(repositoryUrl);
    if (!match) throw new StudixError("VALIDATION", "Not a public GitHub repository URL");
    const name = `${match[1]}/${match[2]}`.toLowerCase();
    const repo = this.repositories.get(name);
    if (!repo) throw new StudixError("NOT_FOUND", "Repository not found or not public");
    return { name, repo };
  }

  async discover(input: SkillDiscoverRequest): Promise<SkillDiscovery> {
    this.calls.discover += 1;
    const { name, repo } = this.lookup(input.repositoryUrl);
    const inScope = (path: string) => !input.path || path === input.path || path.startsWith(`${input.path}/`);
    const skills: SkillCandidate[] = [...repo.skills]
      .filter(([path]) => inScope(path))
      .map(([path, skill]) => ({
        path,
        name: skill.name,
        description: skill.description,
        license: { status: "unknown" as const },
        metadata: {},
        files: { skill: 1 },
        totalBytes: skill.files.reduce((sum, f) => sum + f.content.length, 0),
      }));
    return {
      repository: name,
      ref: input.ref ?? "main",
      commitSha: repo.commitSha,
      skills,
      invalid: [...repo.invalid].filter(([path]) => inScope(path)).map(([path, reason]) => ({ path, reason })),
    };
  }

  async fetchSkills(input: SkillFetchRequest): Promise<SkillFetchResult[]> {
    this.calls.fetch += 1;
    const repo = this.repositories.get(input.repository.toLowerCase());
    if (!repo) throw new StudixError("NOT_FOUND", "Repository not found or not public");
    return input.paths.map((path): SkillFetchResult => {
      const skill = repo.skills.get(path);
      if (!skill) return { path, status: "rejected", reason: "No SKILL.md at this path" };
      return {
        path,
        status: "ok",
        name: skill.name,
        description: skill.description,
        license: { status: "unknown" },
        metadata: {},
        skipped: [],
        files: skill.files.map((f) => {
          const bytes = new TextEncoder().encode(f.content);
          return {
            path: f.path,
            kind: f.kind,
            contentType: f.path.endsWith(".md") ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
            size: bytes.byteLength,
            sha256: sha256(f.content),
            text: true,
            // Script bytes are metadata only: a real source never returns them.
            ...(f.kind === "script" ? {} : { bytes }),
          };
        }),
      };
    });
  }
}
