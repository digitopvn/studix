import type { StageDefinition } from "@studix/workflow";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_KNOWLEDGE_PACKS,
  brandIntroSkill,
  createKnowledgeCatalog,
  createPackRegistry,
  DEFAULT_KNOWLEDGE_LINT_CONFIG,
  formatLintIssues,
  HardCheck,
  type KnowledgePack,
  knowledgeCatalog,
  lintKnowledgePacks,
  loadStageKnowledge,
  meetsThreshold,
  PINNED_SOURCES,
  parseSourceRef,
} from "../src/index.ts";

const ANIME_CREATOR_PACKS = [
  "narrative",
  "performance",
  "art-direction",
  "dop-camera",
  "wardrobe-props",
  "physics-lite",
  "sound",
];

function samplePack(id = "sample", overrides: Partial<KnowledgePack> = {}): KnowledgePack {
  return {
    id,
    version: "1.0.0",
    title: "Sample",
    summary: "A sample pack.",
    purpose: "Exercise the knowledge pack lint.",
    sources: [
      {
        repo: "agentkit",
        ref: `${PINNED_SOURCES.agentkit}:kits/marketing/skills/ak-motion-design/SKILL.md`,
        matrix: "MD-01",
      },
    ],
    phases: ["motion"],
    loadWhen: ["sample"],
    useCases: ["Testing."],
    antiPatterns: ["Skipping the lint."],
    sections: [
      { id: "basics", title: "Basics", entries: [{ id: "one", title: "One", text: "Plain craft text." }] },
    ],
    checks: [
      {
        id: `${id}.hold`,
        kind: "hard",
        level: "shot",
        measure: "Longest hold.",
        metric: { id: "still-hold-max-s", unit: "seconds" },
        threshold: { op: "<=", value: 1.5 },
      },
    ],
    ...overrides,
  };
}

const rules = (packs: unknown[], config = DEFAULT_KNOWLEDGE_LINT_CONFIG) =>
  lintKnowledgePacks(packs, config).map((i) => i.rule);

const stage = (name: string, knowledge?: readonly string[]): StageDefinition => ({
  name,
  ...(knowledge ? { knowledge } : {}),
  run: async () => ({ output: {} }),
});

describe("built-in knowledge packs", () => {
  it("pass the pack lint", () => {
    const issues = lintKnowledgePacks(BUILTIN_KNOWLEDGE_PACKS);
    expect(issues, formatLintIssues(issues)).toEqual([]);
  });

  it("include the seven anime-creator packs and the measured failure modes", () => {
    const ids = BUILTIN_KNOWLEDGE_PACKS.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([...ANIME_CREATOR_PACKS, "production-failure-modes"]));
    for (const id of ANIME_CREATOR_PACKS) {
      const pack = knowledgeCatalog.pack(id);
      expect(pack.sources.some((s) => s.matrix === "AC-37")).toBe(true);
    }
  });

  it("cite every source at the pinned commit with a relative path", () => {
    for (const pack of BUILTIN_KNOWLEDGE_PACKS) {
      for (const source of pack.sources) {
        const ref = parseSourceRef(source.ref);
        expect(ref?.sha, `${pack.id} ${source.ref}`).toBe(PINNED_SOURCES[source.repo]);
        expect(ref?.path.startsWith("/")).toBe(false);
      }
    }
  });

  it("keep the third-party licence notice on adapted MIT portions", () => {
    const motionDesign = knowledgeCatalog.pack("motion-design");
    expect(motionDesign.sources.every((s) => s.notice?.includes("MIT"))).toBe(true);
  });

  it("turn the measured failure modes into hard checks with the source thresholds", () => {
    const hard = new Map(
      knowledgeCatalog
        .hardChecks()
        .filter((c) => c.pack === "production-failure-modes")
        .map((c) => [c.metric.id, c]),
    );
    expect(hard.get("still-hold-max-s")?.threshold).toEqual({ op: "<=", value: 1.5 });
    expect(hard.get("true-peak-dbtp")?.threshold).toEqual({ op: "<=", value: -1.5 });
    expect(hard.get("integrated-loudness-lufs")?.threshold).toEqual({ op: "between", min: -15, max: -13 });
    expect(hard.get("motion-runtime-share")?.threshold).toEqual({ op: ">=", value: 0.6 });
    expect(hard.get("lipsync-offset-frames")?.pendingReview).toMatch(/AC-11/);
    const evidence = knowledgeCatalog
      .pack("production-failure-modes")
      .checks.filter((c) => c.kind === "evidence");
    expect(evidence.length).toBeGreaterThan(0);
  });

  it("declare a unique metric contract per hard check id", () => {
    const checks = knowledgeCatalog.hardChecks();
    expect(new Set(checks.map((c) => c.id)).size).toBe(checks.length);
    for (const { pack: _pack, ...c } of checks) expect(HardCheck.parse(c)).toEqual(c);
  });
});

describe("knowledge pack lint", () => {
  it("accepts a well-formed pack", () => {
    expect(lintKnowledgePacks([samplePack()])).toEqual([]);
  });

  it("reports schema errors, including a hard check without a threshold", () => {
    const noThreshold = samplePack("bad", {
      checks: [
        {
          id: "bad.hold",
          kind: "hard",
          level: "shot",
          measure: "Longest hold.",
          metric: { id: "still-hold-max-s", unit: "seconds" },
        } as unknown as HardCheck,
      ],
    });
    expect(rules([noThreshold])).toContain("schema");
    expect(rules([{ ...samplePack(), sources: [] }])).toContain("schema");
    expect(rules([{ ...samplePack(), version: "1" }])).toContain("schema");
  });

  it("rejects a source without a full SHA or off the pinned commit", () => {
    const shortSha = samplePack("short", {
      sources: [{ repo: "agentkit", ref: "9fe46997:kits/x/SKILL.md", matrix: "MD-01" }],
    });
    expect(rules([shortSha])).toContain("schema");
    const otherSha = samplePack("other", {
      sources: [{ repo: "agentkit", ref: `${"a".repeat(40)}:kits/x/SKILL.md`, matrix: "MD-01" }],
    });
    expect(rules([otherSha])).toEqual(["unpinned-source"]);
  });

  it("finds duplicate pack, section, entry and check ids, and checks outside their pack's prefix", () => {
    expect(rules([samplePack("a"), samplePack("a")])).toEqual(
      expect.arrayContaining(["duplicate-pack", "duplicate-id"]),
    );
    const dupEntries = samplePack("dup", {
      sections: [
        { id: "s", title: "S", entries: [{ id: "e", title: "E", text: "x" }] },
        { id: "s", title: "S2", entries: [{ id: "e", title: "E2", text: "y" }] },
      ],
    });
    expect(lintKnowledgePacks([dupEntries]).map((i) => i.message)).toEqual([
      'section id "s" repeats',
      'entry id "e" repeats',
    ]);
    const foreign = samplePack("mine");
    foreign.checks = [{ ...foreign.checks[0]!, id: "theirs.hold" }];
    expect(rules([foreign])).toEqual(["check-prefix"]);
  });

  it("finds machine paths and credentials anywhere in the content", () => {
    const paths = [
      "See C:\\Users\\me\\film",
      "under /home/me/film",
      "keys in ~/.multix/.env",
      "\\\\nas\\share\\x",
    ];
    for (const text of paths) {
      const pack = samplePack("p", { purpose: text });
      expect(rules([pack]), text).toContain("absolute-path");
    }
    expect(rules([samplePack("p", { purpose: "Use 24 mm, J/L cuts and and/or rules." })])).toEqual([]);
    const secret = samplePack("s", { purpose: "api_key=abcd1234efgh5678" });
    expect(rules([secret])).toContain("secret");
  });

  it("bans configured names on word boundaries, outside the source refs", () => {
    const branded = samplePack("b", { summary: "An apple-like launch film in the ufotable look." });
    const found = lintKnowledgePacks([branded]).filter((i) => i.rule === "banned-term");
    expect(found.map((i) => i.message)).toEqual([
      'names "ufotable", which the lint config bans',
      'names "Apple", which the lint config bans',
    ]);
    expect(rules([samplePack("b", { summary: "Pineapple tones." })])).toEqual([]);
    const custom = { ...DEFAULT_KNOWLEDGE_LINT_CONFIG, bannedTerms: ["Sample"] };
    expect(rules([samplePack("b")], custom)).toEqual(expect.arrayContaining(["banned-term"]));
    // Source refs name real skill directories; they are attribution, not content.
    const sourceOnly = samplePack("c", {
      sources: [
        { repo: "agentkit", ref: `${PINNED_SOURCES.agentkit}:kits/Sample/SKILL.md`, matrix: "MD-01" },
      ],
      title: "T",
      summary: "S",
    });
    expect(rules([sourceOnly], { ...custom, bannedTerms: ["kits"] })).toEqual([]);
  });
});

describe("knowledge catalog", () => {
  it("gives a stage exactly the packs it declared, in its order", () => {
    const catalog = createKnowledgeCatalog(BUILTIN_KNOWLEDGE_PACKS);
    const packs = catalog.forStage(stage("anime.keyframe", ["dop-camera", "performance"]));
    expect(packs.map((p) => p.id)).toEqual(["dop-camera", "performance"]);
    expect(catalog.forStage(stage("brand-intro.compose"))).toEqual([]);
    expect(() => catalog.forStage(stage("x", ["nope"]))).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("loads stage knowledge from the process-wide catalog", () => {
    expect(loadStageKnowledge(stage("anime.mix", ["sound"])).map((p) => p.id)).toEqual(["sound"]);
  });

  it("refuses packs that fail the lint and supports unregistering", () => {
    const catalog = createKnowledgeCatalog([samplePack("a")]);
    expect(() => catalog.register(samplePack("a"))).toThrow(expect.objectContaining({ code: "VALIDATION" }));
    expect(() => catalog.register({ id: "broken" })).toThrow(expect.objectContaining({ code: "VALIDATION" }));
    expect(() => createKnowledgeCatalog([samplePack("x", { purpose: "/home/me" })])).toThrow(
      expect.objectContaining({ code: "VALIDATION" }),
    );
    const off = catalog.register(samplePack("b"));
    expect(catalog.has("b")).toBe(true);
    off();
    expect(catalog.has("b")).toBe(false);
  });

  it("searches packs and entries with BM25 and filters by phase", () => {
    const camera = knowledgeCatalog.search("camera lens framing keyframe");
    expect(camera[0]?.pack).toBe("dop-camera");
    const easing = knowledgeCatalog.search("easing curve entrance", { phase: "motion", limit: 3 });
    expect(easing.length).toBeGreaterThan(0);
    for (const hit of easing) expect(knowledgeCatalog.pack(hit.pack).phases).toContain("motion");
    expect(knowledgeCatalog.search("qqqqxyz")).toEqual([]);
  });
});

describe("pack registry and knowledge", () => {
  it("refuses a stage that declares a knowledge pack the catalog does not hold", () => {
    const catalog = createKnowledgeCatalog(BUILTIN_KNOWLEDGE_PACKS);
    const registry = createPackRegistry([], { knowledge: catalog });
    const pack = (stages: StageDefinition[]) => ({
      id: "anime",
      title: "Anime",
      version: 1,
      templates: [{ ...brandIntroSkill, id: "anime-short" }],
      stages,
    });
    expect(() => registry.register(pack([stage("anime.keyframe", ["dop-camera", "missing"])]))).toThrow(
      expect.objectContaining({
        code: "VALIDATION",
        details: expect.objectContaining({ unknown: ["missing"] }),
      }),
    );
    registry.register(pack([stage("anime.keyframe", ["dop-camera"])]));
    const keyframe = registry.stage("anime.keyframe");
    expect(keyframe && catalog.forStage(keyframe).map((p) => p.id)).toEqual(["dop-camera"]);
  });
});

describe("meetsThreshold", () => {
  it("applies each operator and rejects non-finite values", () => {
    expect(meetsThreshold({ op: "<=", value: 1.5 }, 1.5)).toBe(true);
    expect(meetsThreshold({ op: "<", value: 30 }, 30)).toBe(false);
    expect(meetsThreshold({ op: ">=", value: 0.6 }, 0.59)).toBe(false);
    expect(meetsThreshold({ op: ">", value: -70 }, -69)).toBe(true);
    expect(meetsThreshold({ op: "==", value: 0 }, 0)).toBe(true);
    expect(meetsThreshold({ op: "between", min: -15, max: -13 }, -14.2)).toBe(true);
    expect(meetsThreshold({ op: "between", min: -15, max: -13 }, -12.9)).toBe(false);
    expect(meetsThreshold({ op: "<=", value: 1 }, Number.NaN)).toBe(false);
  });
});
