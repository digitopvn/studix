import { StudixError } from "@studix/shared";
import {
  ASPECT_RATIO_SIZES,
  type AssetRef,
  type AudioTrack,
  type BrandKit,
  buildSequentialTimeline,
  type CaptionCue,
  type Scene,
  type Shot,
  type VideoIR,
  validateVideoIR,
} from "@studix/video-ir";
import { captionCues } from "../caption-chunks.ts";
import { breakLines } from "../vietnamese-safe-text.ts";
import { type MarketingScript, marketingScript, type ScriptAd, VO_PAD_MS } from "./marketing-script.ts";

export const MARKETING_TEMPLATE_VERSION = 1;
const FPS = 30;
const LINE_CHARS = { "9:16": 22, "1:1": 22, "16:9": 36 } as const;

/** Generated media placed into the ads, keyed by `beatKey(ad, beat)`. */
export interface MarketingMedia {
  /** Storyboard frames (one still per beat). */
  frames?: Readonly<Record<string, AssetRef>>;
  /** Image-to-video clips that replace the frames once the storyboard is approved. */
  clips?: Readonly<Record<string, AssetRef>>;
  /** Voice-over, music and sound-effect assets with their tracks (already on the absolute timeline). */
  audio?: { assets: readonly AssetRef[]; tracks: readonly AudioTrack[] };
  /** Assets the brief referenced (only an image matching `brand.logoAssetId` is used). */
  assets?: readonly AssetRef[];
}

/** One ad of the IR, as recorded in `metadata.variants`. */
export interface MarketingVariant {
  id: string;
  name: string;
  /** The IR scene that holds the ad. */
  sceneId: string;
  startMs: number;
  durationMs: number;
}

export const beatKey = (adId: string, beatId: string) => `${adId}-${beatId}`;

/** Where each ad sits on the IR timeline (ads play back to back, one scene each). */
export function marketingVariants(script: MarketingScript): MarketingVariant[] {
  return script.ads.map((ad, i) => ({
    id: ad.id,
    name: ad.name,
    sceneId: ad.id,
    startMs: i * script.durationMs,
    durationMs: script.durationMs,
  }));
}

function adScene(
  ad: ScriptAd,
  script: MarketingScript,
  index: number,
  media: MarketingMedia,
  brand: BrandKit | undefined,
  logo: AssetRef | undefined,
): Scene {
  const chars = LINE_CHARS[script.aspectRatio];
  const shots: Shot[] = [];
  const last = ad.beats.length - 1;
  ad.beats.forEach((beat, i) => {
    const key = beatKey(ad.id, beat.id);
    const clip = media.clips?.[key];
    const frame = media.frames?.[key];
    if (clip) {
      shots.push({
        id: `${key}-media`,
        type: "video",
        startMs: beat.startMs,
        durationMs: beat.durationMs,
        assetId: clip.id,
        muted: true,
        fit: "cover",
      });
    } else if (frame) {
      shots.push({
        id: `${key}-media`,
        type: "image",
        startMs: beat.startMs,
        durationMs: beat.durationMs,
        assetId: frame.id,
        alt: beat.visual.slice(0, 300),
        fit: "cover",
        animation: { enter: i === 0 ? "none" : "fade", durationMs: 250 },
      });
    }
    if (i === last) return;
    if (beat.onScreen) {
      shots.push({
        id: `${key}-text`,
        type: i === 0 ? "title" : "text",
        startMs: beat.startMs + 150,
        durationMs: beat.durationMs - 150,
        text: breakLines(beat.onScreen, chars),
        style: {
          textStyle: i === 0 ? "display" : "heading",
          color: "foreground",
          align: "center",
          region: "top",
        },
        animation: { enter: i === 0 ? "scale" : "slide-up", exit: "fade", durationMs: 300 },
      });
    }
  });
  const outro = ad.beats[last] as (typeof ad.beats)[number];
  if (logo || brand?.name) {
    shots.push({
      id: `${ad.id}-logo`,
      type: "logo",
      startMs: outro.startMs,
      durationMs: outro.durationMs,
      ...(logo ? { assetId: logo.id } : { text: (brand?.name ?? "").slice(0, 60) }),
      style: { textStyle: "heading", color: "accent", align: "center", region: "top" },
      animation: { enter: "fade", durationMs: 400 },
    });
  }
  shots.push({
    id: `${ad.id}-cta`,
    type: "cta",
    startMs: outro.startMs + 300,
    durationMs: outro.durationMs - 300,
    text: breakLines(outro.onScreen ?? ad.callToAction, chars - 2).slice(0, 120),
    style: { textStyle: "heading", color: "foreground", align: "center", region: "middle", emphasis: "high" },
    animation: { enter: "pop", durationMs: 400 },
  });
  return {
    id: ad.id,
    role: "custom",
    durationMs: script.durationMs,
    background: { color: index % 2 === 0 ? "primary" : "background" },
    shots,
    notes: `${ad.name}: ${ad.concept}`.slice(0, 1000),
  };
}

/** Burned captions of every ad's voice-over, one chunked cue run per beat line. */
function adCaptions(script: MarketingScript): CaptionCue[] {
  return marketingVariants(script).flatMap((variant, i) =>
    (script.ads[i] as ScriptAd).beats.flatMap((beat) => {
      if (!beat.voiceover) return [];
      const first = beat.startMs === 0;
      const start = variant.startMs + beat.startMs + (first ? VO_PAD_MS : 0);
      const end =
        variant.startMs +
        beat.startMs +
        beat.durationMs -
        (beat.startMs + beat.durationMs >= script.durationMs ? VO_PAD_MS : 0);
      return captionCues(beat.voiceover, start, end - start);
    }),
  );
}

/**
 * The IR of a marketing script: every ad as one scene, back to back, with on-screen lines, a logo and CTA
 * end card, and burned voice-over captions. `media` adds the storyboard frames, then the clips and the
 * audio mix once they exist; without frames each beat is a brand-colour text card (the animatic).
 * Pure; the result is checked with validateVideoIR, and a failure there is a template bug (INTERNAL).
 */
export function marketingVideoIr(
  script: MarketingScript,
  brand: BrandKit | undefined,
  title: string,
  media: MarketingMedia = {},
): VideoIR {
  const logo = brand?.logoAssetId
    ? media.assets?.find((a) => a.id === brand.logoAssetId && a.kind === "image")
    : undefined;
  const { logoAssetId: _logo, ...brandWithoutLogo } = brand ?? { logoAssetId: undefined };
  const irBrand = brand ? (logo ? brand : (brandWithoutLogo as BrandKit)) : undefined;
  const scenes = script.ads.map((ad, i) => adScene(ad, script, i, media, brand, logo));
  // Frames stay listed after clips replace them, so the storyboard keeps its stills for review.
  const assets = [
    ...(logo ? [logo] : []),
    ...Object.values(media.frames ?? {}),
    ...Object.values(media.clips ?? {}),
    ...(media.audio?.assets ?? []),
  ].filter((a, i, all) => all.findIndex((b) => b.id === a.id) === i);
  const cues = adCaptions(script);
  const ir: VideoIR = {
    schemaVersion: 1,
    title: title.slice(0, 200),
    language: script.language,
    format: {
      aspectRatio: script.aspectRatio,
      ...ASPECT_RATIO_SIZES[script.aspectRatio],
      fps: FPS,
      durationMs: script.durationMs * script.ads.length,
    },
    ...(irBrand ? { brand: irBrand } : {}),
    assets,
    scenes,
    timeline: buildSequentialTimeline(scenes),
    ...(media.audio && media.audio.tracks.length > 0 ? { audio: [...media.audio.tracks] } : {}),
    ...(cues.length > 0
      ? { captions: { language: script.language, mode: "burned", position: "bottom", cues } }
      : {}),
    metadata: {
      template: "marketing-video",
      templateVersion: MARKETING_TEMPLATE_VERSION,
      variants: marketingVariants(script),
    },
  };
  const result = validateVideoIR(ir);
  if (!result.ok) {
    throw new StudixError("INTERNAL", "The marketing-video template produced an invalid IR", {
      details: { issues: result.issues.slice(0, 10) },
    });
  }
  return result.value;
}

/** Template entry (`Skill.run`): the text-card animatic of a marketing brief, before any frame exists. */
export function marketingVideoTemplate(
  input: unknown,
  options: { assets?: readonly AssetRef[] } = {},
): VideoIR {
  const script = marketingScript(input);
  const brief = input as { title?: string; brand?: BrandKit; prompt: string };
  const title = brief.title ?? brief.brand?.name ?? brief.prompt.slice(0, 80);
  return marketingVideoIr(script, brief.brand, title, { assets: options.assets });
}
