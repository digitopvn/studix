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
  MOTION_STYLE_PROFILES,
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

describe("owner-approved knowledge ports", () => {
  const section = (pack: string, id: string) => {
    const found = knowledgeCatalog.pack(pack).sections.find((s) => s.id === id);
    if (!found) throw new Error(`${pack} has no section ${id}`);
    return found;
  };
  const styleIds = new Set(section("creative-direction", "visual-styles").entries.map((e) => e.id));
  const idList = (value: string | undefined) => (value ?? "").split(",").map((s) => s.trim());
  const sourcesOf = (pack: string, matrix: string) =>
    knowledgeCatalog.pack(pack).sources.filter((s) => s.matrix === matrix);

  it("give every campaign category a style pair from the visual style registry", () => {
    const campaigns = section("creative-direction", "campaign-reasoning").entries.filter((e) =>
      e.tags?.includes("campaign-reasoning"),
    );
    const rows = campaigns.filter((e) => e.id.startsWith("campaign-") && e.fields?.stylePriority);
    expect(rows).toHaveLength(30);
    for (const row of rows) {
      const styles = idList(row.fields?.stylePriority);
      expect(styles, row.id).toHaveLength(2);
      for (const id of styles) expect(styleIds.has(id), `${row.id} -> ${id}`).toBe(true);
      expect(row.fields?.severity).toMatch(/^(high|medium)$/);
    }
    expect(sourcesOf("creative-direction", "CR-05")).toHaveLength(1);
  });

  it("list only music sources whose licence route is stated", () => {
    const music = section("creative-direction", "music-sources").entries.filter((e) =>
      e.tags?.includes("music"),
    );
    const genres = music.filter((e) => e.id.startsWith("music-") && e.fields?.licence);
    expect(genres.map((e) => e.id).sort()).toEqual(
      [
        "music-ambient-electronic",
        "music-anthemic-rock",
        "music-corporate-subtle",
        "music-dark-electronic",
        "music-indie-acoustic",
        "music-nature-ambient",
        "music-orchestral-cinematic",
        "music-quirky-playful",
        "music-synthwave",
        "music-upbeat-pop",
      ].sort(),
    );
    for (const genre of genres) {
      expect(genre.fields?.licence, genre.id).toMatch(/licen[cs]e/i);
      for (const id of idList(genre.fields?.styleMatch))
        expect(styleIds.has(id), `${genre.id} -> ${id}`).toBe(true);
    }
    expect(sourcesOf("creative-direction", "CR-06").map((s) => s.ref)).toEqual([
      expect.stringMatching(/data\/music\.csv$/),
    ]);
  });

  it("carry the GLSL listings with the MIT notices of their third-party code", () => {
    const listings = knowledgeCatalog
      .pack("shader-gl")
      .sections.filter((s) => s.id.endsWith("-glsl"))
      .flatMap((s) => s.entries);
    expect(listings.length).toBeGreaterThan(70);
    for (const entry of listings) expect(entry.fields?.glsl?.trim(), entry.id).toBeTruthy();
    const simplex = listings.find((e) => e.id === "glsl-simplex-noise-2d");
    expect(simplex?.fields?.glsl).toContain("simplexNoise");
    expect(simplex?.text).toMatch(/MIT/);
    const notices = sourcesOf("shader-gl", "SH-03").filter((s) => s.notice);
    expect(notices.map((s) => s.notice)).toEqual([
      expect.stringMatching(/MIT/),
      expect.stringMatching(/MIT/),
    ]);
    // The built-in function reference stays out (generic GLSL spec).
    expect(sourcesOf("shader-gl", "SH-03").some((s) => s.ref.includes("builtin-functions"))).toBe(false);
  });

  it("index every upstream three.js example with its file and URL", () => {
    const examples = knowledgeCatalog
      .pack("threejs")
      .sections.flatMap((s) => s.entries)
      .filter((e) => e.tags?.includes("threejs-example"));
    expect(examples).toHaveLength(556);
    expect(new Set(examples.map((e) => e.fields?.file)).size).toBe(556);
    for (const e of examples) {
      expect(e.fields?.url).toBe(`https://threejs.org/examples/${e.fields?.file}`);
      expect(e.fields?.complexity).toMatch(/^(low|medium|high)$/);
    }
    expect(sourcesOf("threejs", "TJ-03").map((s) => s.notice)).toEqual([expect.stringMatching(/MIT/)]);
  });

  it("name the forty signature motion styles by their look, never by a brand", () => {
    const styles = section("signature-motion-styles", "styles").entries;
    expect(styles).toHaveLength(40);
    // Stricter than the pack lint: brand names that are also English words must not name a style either.
    const brandWords = [
      ...DEFAULT_KNOWLEDGE_LINT_CONFIG.bannedTerms,
      "Notion",
      "Linear",
      "Slack",
      "Stripe",
      "Vox",
      "Carbon",
      "Fluent",
      "Material",
      "Android",
      "Coke",
    ];
    const strict = { ...DEFAULT_KNOWLEDGE_LINT_CONFIG, bannedTerms: brandWords };
    const naming = styles.map((s) => ({
      id: s.id,
      title: s.title,
      aliases: s.fields?.aliases,
      tags: s.tags,
    }));
    expect(
      lintKnowledgePacks([samplePack("names", { useCases: [JSON.stringify(naming)] })], strict).map(
        (i) => i.message,
      ),
    ).toEqual([]);
    for (const style of styles)
      expect(idList(style.fields?.aliases).length, style.id).toBeGreaterThanOrEqual(3);
    // The whole pack, sources aside, passes the default lint, which bans the brands the source aliases used.
    expect(lintKnowledgePacks([knowledgeCatalog.pack("signature-motion-styles")])).toEqual([]);
    expect(sourcesOf("signature-motion-styles", "MV-14").length).toBe(42);
  });

  it("pair each signature style only with profiles Studix ships", () => {
    const known = new Set([
      ...section("signature-motion-styles", "styles").entries.map((e) => e.id),
      ...MOTION_STYLE_PROFILES.map((p) => p.id),
    ]);
    for (const style of section("signature-motion-styles", "styles").entries) {
      for (const id of idList(style.fields?.pairsWellWith).filter(Boolean)) {
        expect(known.has(id), `${style.id} -> ${id}`).toBe(true);
      }
    }
  });

  it("find a signature style from a look description", () => {
    const hits = knowledgeCatalog.search("premium product film centred hero", { phase: "design", limit: 5 });
    expect(hits.some((h) => h.pack === "signature-motion-styles")).toBe(true);
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
