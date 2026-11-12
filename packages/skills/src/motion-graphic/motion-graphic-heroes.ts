import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toStudixError } from "@studix/shared";
import {
  HTML_CARD_FORMAT,
  HTML_CARD_MIME,
  type HtmlCardPackage,
  htmlCardProblems,
} from "@studix/renderers/html-card";
import { type AssetRef, type Scene, VideoIR } from "@studix/video-ir";
import {
  irOf,
  requireService,
  type StageContext,
  type StageDefinition,
  sha256File,
  stageCacheKey,
  stageWorkDir,
} from "@studix/workflow";
import { z } from "zod";
import { truncateText } from "../vietnamese-safe-text.ts";
import { MG_STORYBOARD_STAGE, type MotionHeroCard, MotionStoryboardOutput } from "./motion-graphic-storyboard.ts";

export const MG_HEROES_STAGE = "motion-graphic.heroes";

const HeroesOutput = z.object({ ir: VideoIR, warning: z.string().max(500).optional() });

/** The premium storyboard's hero cards, or none (standard tier, template fallback, older checkpoints). */
function heroesOf(s: StageContext): MotionHeroCard[] {
  const parsed = MotionStoryboardOutput.safeParse(s.outputs[MG_STORYBOARD_STAGE]);
  return parsed.success ? (parsed.data.storyboard?.heroes ?? []) : [];
}

const packageOf = (hero: MotionHeroCard): HtmlCardPackage => ({
  format: HTML_CARD_FORMAT,
  version: 1,
  html: hero.html,
  css: hero.css,
  script: hero.script,
});

/** Why a hero card is not used, in one short line for the stage warning. */
const rejected = (beat: number, reasons: readonly string[]) =>
  `beat ${beat}: ${reasons.slice(0, 2).join("; ")}${reasons.length > 2 ? ` (+${reasons.length - 2} more)` : ""}`;

/**
 * Premium tier: each hero card the director wrote replaces the built-in card of its beat with an HTML-card
 * composition shot, once it passes the HTML-card safety rules and the HyperFrames linter. A card that fails,
 * names the call to action or a beat the graphic does not have keeps the built-in card and adds a warning, so a
 * premium job never fails where a standard one renders. Runs after the voice and music stages, so every card
 * already has its final length; the render QA gate then checks the hero cards like any other frame. Free.
 */
export const motionGraphicHeroesStage: StageDefinition = {
  name: MG_HEROES_STAGE,
  knowledge: ["motion-craft", "composition-timing"],
  outputSchema: HeroesOutput,
  cacheKey: (s) => stageCacheKey(MG_HEROES_STAGE, 1, { ir: irOf(s), heroes: heroesOf(s) }),
  async run(s) {
    const ir = irOf(s);
    const heroes = heroesOf(s);
    if (heroes.length === 0) return { output: { ir } };
    const { lintHtmlCard } = await import("@studix/renderers");
    const storage = requireService(s, "storage");
    const workDir = await stageWorkDir(s, MG_HEROES_STAGE);
    const warnings: string[] = [];
    const scenes = [...ir.scenes];
    const assets: AssetRef[] = [];
    const seen = new Set<number>();
    try {
      for (const hero of heroes) {
        const scene = scenes[hero.beat];
        if (seen.has(hero.beat) || !scene || hero.beat >= scenes.length - 1) {
          warnings.push(rejected(hero.beat, ["not a card the graphic has before its call to action"]));
          continue;
        }
        seen.add(hero.beat);
        const pkg = packageOf(hero);
        const problems = htmlCardProblems(pkg);
        if (problems.length > 0) {
          warnings.push(rejected(hero.beat, problems));
          continue;
        }
        const lint = await lintHtmlCard(pkg, {
          width: ir.format.width,
          height: ir.format.height,
          durationMs: scene.durationMs,
          ...(ir.brand ? { palette: ir.brand.palette, fonts: ir.brand.fonts } : {}),
          workDir,
        });
        if (lint.errors.length > 0) {
          warnings.push(rejected(hero.beat, lint.errors.map((e) => `lint: ${e}`)));
          continue;
        }
        const file = join(workDir, `${scene.id}.card.json`);
        await writeFile(file, JSON.stringify(pkg));
        const { sha256 } = await sha256File(file);
        const stored = await storage.put(
          s.ctx,
          `generated/${s.job.id}/heroes/${scene.id}.json`,
          { filePath: file },
          { contentType: HTML_CARD_MIME, sha256 },
        );
        const asset: AssetRef = {
          id: `${scene.id}-hero`.slice(0, 64),
          kind: "code",
          storageKey: stored.key,
          sha256: stored.sha256,
          mime: HTML_CARD_MIME,
          bytes: stored.bytes,
          assetVersionId: `asv_${stored.sha256.slice(0, 24)}`,
          provenance: { source: "generated", provider: "studix-director" },
        };
        assets.push(asset);
        const card: Scene = {
          ...scene,
          shots: [
            {
              id: asset.id,
              type: "composition",
              startMs: 0,
              durationMs: scene.durationMs,
              assetId: asset.id,
              style: { region: "full" },
            },
          ],
        };
        scenes[hero.beat] = card;
      }
    } catch (err) {
      await rm(workDir, { recursive: true, force: true });
      throw toStudixError(err);
    }
    await rm(workDir, { recursive: true, force: true });
    const next = VideoIR.parse({
      ...ir,
      scenes,
      assets: [...ir.assets.filter((a) => !assets.some((b) => b.id === a.id)), ...assets],
      metadata: { ...ir.metadata, heroCards: assets.length },
    });
    const warning =
      warnings.length > 0
        ? truncateText(`Hero cards kept the built-in card: ${warnings.join(" | ")}`, 500)
        : undefined;
    return { output: { ir: next, ...(warning ? { warning } : {}) } };
  },
};
