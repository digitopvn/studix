import { StudixError } from "@studix/shared";
import { buildSequentialTimeline, type CaptionCue, type Shot, type VideoIR } from "@studix/video-ir";
import { z } from "zod";

export const VariantSpan = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sceneId: z.string().min(1),
  startMs: z.number().int().min(0),
  durationMs: z.number().int().positive(),
});
export type VariantSpan = z.infer<typeof VariantSpan>;

/** The ads of a marketing-video IR, from `metadata.variants` (written by the template). */
export function irVariants(ir: VideoIR): VariantSpan[] {
  const parsed = z.array(VariantSpan).min(1).safeParse(ir.metadata?.variants);
  if (!parsed.success) {
    throw new StudixError("VALIDATION", "This IR has no marketing-video variants", {
      retryable: false,
      details: { issues: parsed.error.issues.slice(0, 5) },
      suggestedAction: "Create the project with workflowTemplate marketing-video.",
    });
  }
  for (const v of parsed.data) {
    if (!ir.scenes.some((s) => s.id === v.sceneId)) {
      throw new StudixError("VALIDATION", `Variant ${v.id} names a scene the IR does not have`, {
        retryable: false,
        details: { variant: v.id, sceneId: v.sceneId },
      });
    }
  }
  return parsed.data;
}

/**
 * Ads are full-bleed: a frame or clip that names no region fills the whole frame under the copy (its
 * storyboard prompt leaves room above and below for the text). A region the IR names is kept.
 */
function fullBleed(shot: Shot): Shot {
  if ((shot.type !== "image" && shot.type !== "video") || shot.style?.region) return shot;
  return { ...shot, style: { ...shot.style, region: "full" } };
}

const COPY_TYPES = new Set<Shot["type"]>(["title", "text", "logo", "cta"]);

/**
 * Copy over footage sits on a brand-background card so it stays legible whatever the clip shows. A CTA in
 * the middle would cover the clip's subject, which the frame centres, and a clip that pushes in brings the
 * subject's face up into the top band, so the CTA takes the lower band, under the subject.
 */
function onFootage(shot: Shot): Shot {
  if (!COPY_TYPES.has(shot.type)) return shot;
  const region =
    shot.type === "cta" && (shot.style?.region ?? "middle") === "middle" ? "bottom" : shot.style?.region;
  return {
    ...shot,
    style: {
      ...shot.style,
      background: shot.style?.background ?? "background",
      ...(region ? { region } : {}),
    },
  };
}

/** Lower-case words only, so a caption chunk matches its line whatever the breaks and punctuation. */
const words = (text: string) =>
  text
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(" ");

/**
 * Whether a caption cue only repeats copy already on screen while it shows: a burned caption of the same
 * words adds nothing and crowds the frame. Captions of a voice-over that says something else are kept.
 */
function repeatsCopy(cue: CaptionCue, shots: readonly Shot[]): boolean {
  const said = words(cue.text);
  if (!said) return false;
  return shots.some(
    (s) =>
      COPY_TYPES.has(s.type) &&
      "text" in s &&
      typeof s.text === "string" &&
      s.startMs < cue.endMs &&
      s.startMs + s.durationMs > cue.startMs &&
      ` ${words(s.text)} `.includes(` ${said} `),
  );
}

const overlaps = (shot: Shot, cue: CaptionCue) =>
  shot.startMs < cue.endMs && shot.startMs + shot.durationMs > cue.startMs;

/**
 * Bottom-band copy that would show with a burned caption at the bottom: it goes to the top band instead,
 * so the copy and the caption never sit on each other.
 */
function clearOfCaptions(shots: Shot[], cues: readonly CaptionCue[], position: string | undefined): Shot[] {
  if ((position ?? "bottom") !== "bottom") return shots;
  return shots.map((s) =>
    COPY_TYPES.has(s.type) && s.style?.region === "bottom" && cues.some((c) => overlaps(s, c))
      ? { ...s, style: { ...s.style, region: "top" } }
      : s,
  );
}

/**
 * The standalone IR of one ad: its scene alone, with the audio tracks and caption cues that fall inside
 * the ad moved to start at zero (minus captions that only repeat on-screen copy), its pictures full-bleed
 * under carded copy (the CTA in the lower band unless a caption shows there with it), and only the assets
 * it uses. Each ad renders and ships as its own file.
 */
export function variantIr(ir: VideoIR, variant: VariantSpan): VideoIR {
  const scene = ir.scenes.find((s) => s.id === variant.sceneId);
  if (!scene) throw new StudixError("INTERNAL", `scene ${variant.sceneId} is missing`, { retryable: false });
  const from = variant.startMs;
  const to = variant.startMs + variant.durationMs;
  const audio = (ir.audio ?? [])
    .filter((t) => t.startMs >= from && t.startMs < to)
    .map((t) => ({
      ...t,
      startMs: t.startMs - from,
      durationMs: Math.min(t.durationMs ?? to - t.startMs, to - t.startMs),
    }));
  const used = new Set<string>();
  for (const shot of scene.shots) if ("assetId" in shot && shot.assetId) used.add(shot.assetId);
  if (scene.background?.assetId) used.add(scene.background.assetId);
  if (ir.brand?.logoAssetId) used.add(ir.brand.logoAssetId);
  for (const track of audio) used.add(track.assetId);
  const pictures = scene.shots.map(fullBleed);
  const carded = pictures.some((s) => s.style?.region === "full") ? pictures.map(onFootage) : pictures;
  const cues = (ir.captions?.cues ?? [])
    .filter((c) => c.startMs >= from && c.endMs <= to)
    .map((c) => ({ ...c, startMs: c.startMs - from, endMs: c.endMs - from }))
    .filter((c) => !repeatsCopy(c, carded));
  const shots = clearOfCaptions(carded, cues, ir.captions?.position);
  const { captions: _captions, audio: _audio, ...rest } = ir;
  return {
    ...rest,
    title: `${ir.title} — ${variant.name}`.slice(0, 200),
    format: { ...ir.format, durationMs: variant.durationMs },
    assets: ir.assets.filter((a) => used.has(a.id)),
    scenes: [{ ...scene, shots, durationMs: variant.durationMs }],
    timeline: buildSequentialTimeline([{ id: scene.id, durationMs: variant.durationMs }]),
    ...(audio.length > 0 ? { audio } : {}),
    ...(cues.length > 0 && ir.captions ? { captions: { ...ir.captions, cues } } : {}),
    metadata: { ...ir.metadata, variants: [{ ...variant, startMs: 0 }] },
  };
}
