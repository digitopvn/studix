import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TenantContext } from "@studix/core";
import { HTML_CARD_MIME } from "@studix/renderers/html-card";
import { type VideoIR, validateVideoIR } from "@studix/video-ir";
import type { StageContext } from "@studix/workflow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { motionGraphicHeroesStage } from "../src/motion-graphic/motion-graphic-heroes.ts";
import {
  MG_STORYBOARD_STAGE,
  type MotionStoryboard,
  premiumDirector,
  settledStoryboard,
} from "../src/motion-graphic/motion-graphic-storyboard.ts";
import { motionGraphicTemplate } from "../src/motion-graphic/motion-graphic-template.ts";
import { MOTION_STYLE_PROFILES } from "../src/motion-graphic/motion-style-profiles.ts";

/** Families the renderer bundles (with a Vietnamese subset). */
const BUNDLED = [
  "Be Vietnam Pro",
  "Inter",
  "Playfair Display",
  "Oswald",
  "Space Grotesk",
  "Plus Jakarta Sans",
  "JetBrains Mono",
];

const storyboard = (styleProfile: string, enter = "pop"): MotionStoryboard => ({
  styleProfile,
  beats: [
    { onScreen: "Ship faster", voiceover: "Ship faster.", visual: "title", enter: enter as "pop", weight: 1 },
    { onScreen: "One tool", voiceover: "One tool.", visual: "stat", enter: "fade", weight: 1 },
    { onScreen: "Try it", voiceover: "Try it today.", visual: "cta", enter: "fade", weight: 1 },
  ],
  music: null,
  rationale: "test",
});

const brief = (extra: Record<string, unknown> = {}) => ({
  prompt: "Launch film",
  durationMs: 12_000,
  ...extra,
});

describe("motion style presets", () => {
  it("gives every profile bundled fonts, allowed entrances, a cut and juice", () => {
    const ids = new Set<string>();
    for (const p of MOTION_STYLE_PROFILES) {
      expect(ids.has(p.id)).toBe(false);
      ids.add(p.id);
      expect(BUNDLED).toContain(p.fonts.heading);
      expect(BUNDLED).toContain(p.fonts.body);
      expect(p.pacing.enters.length).toBeGreaterThan(0);
      expect(p.pacing.enters).not.toContain("none");
      expect(typeof p.juice.ctaFill).toBe("boolean");
      for (const c of Object.values(p.palette)) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
    for (const id of ["cinematic-product-launch", "glass-keynote", "keynote-stage", "athletic-impact"])
      expect(ids.has(id)).toBe(true);
  });

  it("locks palette, fonts, entrances, cut and juice to the profile", () => {
    const ir = motionGraphicTemplate(brief(), { storyboard: storyboard("cinematic-product-launch") });
    expect(validateVideoIR(ir).ok).toBe(true);
    expect(ir.metadata).toMatchObject({ styleProfile: "cinematic-product-launch", juice: { whoosh: false } });
    expect(ir.brand?.fonts).toEqual({ heading: "Inter", body: "Inter" });
    // "pop" is not a cinematic entrance: the profile's default replaces it.
    expect(ir.scenes[0]?.shots[0]?.animation?.enter).toBe("fade");
    // The hook match-cuts into the first message; the cut into the call to action is the preset's own.
    expect(ir.scenes[0]?.transitionOut?.kind).toBe("match-cut");
    expect(ir.scenes.at(-2)?.transitionOut).toEqual({ kind: "fade", durationMs: 600 });
    expect(ir.scenes.at(-1)?.background?.color).toBe("background");

    const hype = motionGraphicTemplate(brief(), { storyboard: storyboard("athletic-impact") });
    expect(hype.scenes[0]?.shots[0]?.animation?.enter).toBe("pop");
    expect(hype.scenes.at(-2)?.transitionOut?.kind).toBe("cut");
    expect(hype.scenes.at(-1)?.background?.color).toBe("primary");
    expect(hype.brand?.fonts.heading).toBe("Oswald");
  });

  it("pins the profile a brief names over the storyboard's pick, and a brand kit keeps its own fonts", () => {
    const pinned = brief({
      directions: [{ id: "a", name: "a", concept: "a", visualStyle: "glass-keynote" }],
    });
    const ir = motionGraphicTemplate(pinned, { storyboard: storyboard("neon-cyberpunk") });
    expect(ir.metadata?.styleProfile).toBe("glass-keynote");
    expect(ir.brand?.fonts.heading).toBe("Plus Jakarta Sans");
    const branded = motionGraphicTemplate(
      brief({
        brand: {
          name: "Lá Mây",
          palette: { primary: "#2f6b4f", background: "#f4efe6", foreground: "#1d2a24" },
          fonts: { heading: "Be Vietnam Pro", body: "Be Vietnam Pro" },
        },
      }),
      { storyboard: storyboard("glass-keynote") },
    );
    expect(branded.brand?.fonts.heading).toBe("Be Vietnam Pro");
  });

  it("runs the premium tier only when the job names a director", () => {
    const agent = { runtime: "claude", connectionId: "pc_1", provider: "anthropic" };
    expect(premiumDirector({ roles: { director: agent } })).toBe(true);
    expect(premiumDirector({ agent })).toBe(false);
    expect(premiumDirector({ roles: { qa: agent } })).toBe(false);
    expect(premiumDirector(undefined)).toBe(false);
  });

  it("keeps a hero only on the premium tier and only on the beat whose line it names", () => {
    const hero = { html: "<p>x</p>", css: "", tweens: [] };
    const sb: MotionStoryboard = {
      ...storyboard("glass-keynote"),
      heroes: [
        { beat: 0, onScreen: "Ship faster", ...hero },
        // A repair moved the beats: this card was written for a line beat 1 no longer shows.
        { beat: 1, onScreen: "Two tools", ...hero },
      ],
    };
    expect(settledStoryboard(brief(), sb, true).heroes?.map((h) => h.beat)).toEqual([0]);
    expect(settledStoryboard(brief(), sb, false).heroes).toBeUndefined();
  });
});

const ctx: TenantContext = {
  organizationId: "org_1",
  workspaceId: "ws_1",
  actor: { type: "user", id: "usr_1", role: "owner" },
};

const hero = {
  html: '<div class="wrap"><h1 class="title">Ship faster</h1><svg class="ring" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" stroke-width="4"/></svg></div>',
  css: ".wrap { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--c-foreground); } .title { font-family: var(--font-heading); font-size: 8vmin; margin: 0; } .ring { width: 30%; color: var(--c-accent); }",
  tweens: [
    { target: ".title", at: 0, duration: 0.6, from: { y: 40, opacity: 0 }, ease: "power3.out" },
    { target: ".ring", at: 0.2, duration: 0.8, from: { scale: 0.6, opacity: 0 }, ease: "expo.out" },
  ],
};

describe("motion-graphic hero cards", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "studix-mg-heroes-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const stage = (ir: VideoIR, heroes: unknown[]) => {
    const puts: string[] = [];
    const storage = {
      put: async (_c: TenantContext, key: string, _b: unknown, opts: { sha256?: string }) => {
        puts.push(key);
        return { key, sha256: opts.sha256 ?? "", bytes: 10 };
      },
    };
    const s = {
      ctx,
      job: { id: "job_1", payload: {} },
      attempt: 1,
      signal: new AbortController().signal,
      outputs: {
        [MG_STORYBOARD_STAGE]: { source: "agent", storyboard: { ...storyboard("glass-keynote"), heroes } },
        "motion-graphic.music": { ir },
      },
      services: { storage, workRoot: root },
      reportProgress: () => {},
    } as unknown as StageContext;
    return { s, puts };
  };

  it("swaps a valid hero in as an HTML-card shot and keeps the built-in card for a broken one", async () => {
    const ir = motionGraphicTemplate(brief(), { storyboard: storyboard("glass-keynote") });
    const { s, puts } = stage(ir, [
      { beat: 0, onScreen: "Ship faster", ...hero },
      {
        beat: 1,
        onScreen: "One tool",
        ...hero,
        html: '<div><script>fetch("https://example.com")</script></div>',
      },
      { beat: 2, onScreen: "Try it", ...hero },
    ]);
    const result = await motionGraphicHeroesStage.run(s);
    const out = result.output as { ir: VideoIR; warning?: string };
    expect(validateVideoIR(out.ir).ok).toBe(true);
    const [hook, message, cta] = out.ir.scenes;
    expect(hook?.shots).toEqual([
      expect.objectContaining({ type: "composition", assetId: "hook-hero", durationMs: hook?.durationMs }),
    ]);
    expect(out.ir.assets.find((a) => a.id === "hook-hero")).toMatchObject({
      kind: "code",
      mime: HTML_CARD_MIME,
    });
    expect(message?.shots.some((sh) => sh.type === "composition")).toBe(false);
    expect(cta?.shots.some((sh) => sh.type === "composition")).toBe(false);
    expect(out.warning).toMatch(/beat 1: .*script/i);
    expect(out.warning).toMatch(/beat 2/);
    expect(out.ir.metadata?.heroCards).toBe(1);
    expect(puts).toEqual(["generated/job_1/heroes/hook.json"]);
  });

  it("leaves a graphic without hero cards untouched", async () => {
    const ir = motionGraphicTemplate(brief(), { storyboard: storyboard("glass-keynote") });
    const { s } = stage(ir, []);
    const result = await motionGraphicHeroesStage.run(s);
    expect((result.output as { ir: VideoIR }).ir).toEqual(ir);
  });
});
