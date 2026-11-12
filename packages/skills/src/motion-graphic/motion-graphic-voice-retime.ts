import { StudixError, toStudixError } from "@studix/shared";
import {
  type AssetRef,
  type AudioTrack,
  type CreativeBrief,
  resolveSceneSpans,
  VideoIR,
} from "@studix/video-ir";
import { mapBounded, type StageContext, StageFailedAfterSpend, type StageUsage } from "@studix/workflow";
import { hasStoredOutput, type StoredMediaRequest } from "../stored-media.ts";
import {
  MAX_VOICE_SPEEDUP,
  takeSpeechMs,
  type VoiceLine,
  voiceLines,
  voiceLineTrack,
  voiceTakeFits,
  withVoiceover,
} from "../voice-lines.ts";
import { briskerTake, type MeasuredVoiceTake, measuredVoiceTake } from "../voice-takes.ts";
import { replaceSfxTracks } from "./motion-graphic-sfx-timing.ts";
import { type CardWords, estimateWords, placeWords, withSpokenWords } from "./motion-graphic-spoken-words.ts";
import type { MotionStoryboard } from "./motion-graphic-storyboard.ts";
import { cardNeeds, motionGraphicTemplate } from "./motion-graphic-template.ts";

/** What the compose stage built the graphic from; the voice stage re-cuts the cards from the same. */
export interface GraphicSource {
  brief: CreativeBrief;
  assets?: AssetRef[];
  storyboard?: MotionStoryboard;
}

export interface PlannedVoiceLine {
  line: VoiceLine;
  request: StoredMediaRequest;
}

/** The scene index each line is voiced on: the card its first caption starts in. */
function cardsOf(ir: VideoIR, lines: readonly VoiceLine[]): number[] {
  const spans = resolveSceneSpans(ir.timeline, ir.scenes);
  return lines.map((line) => {
    const span = spans.find((sp) => line.startMs >= sp.startMs && line.startMs < sp.endMs);
    return span ? ir.scenes.findIndex((sc) => sc.id === span.sceneId) : -1;
  });
}

const speechOf = (t: MeasuredVoiceTake) => takeSpeechMs(t.lengthMs, t.measured);
const fits = (line: VoiceLine, t: MeasuredVoiceTake) => voiceTakeFits(line, t.lengthMs, t.measured);

type Retimed = { ir: VideoIR; lines: VoiceLine[] } | { neededMs: number };

/**
 * The graphic with its cards re-cut to the measured takes: the same length, every card at least its take's
 * speech plus the lead-in and closing pads, the rest shared by the storyboard weights. Scenes, timeline and
 * captions come from the template as compose built them, and the accent stage's SFX follow the new cuts.
 * Lines keep their text and direction (their requests, and so their takes, stay the same) and get their
 * new start and room. `neededMs` when the takes need more than the whole graphic. With `rate` above 1 the
 * cards are cut for the takes read that much faster (the track speeds them up, up to `MAX_VOICE_SPEEDUP`).
 */
function retimed(
  ir: VideoIR,
  source: GraphicSource,
  lines: readonly VoiceLine[],
  takes: readonly MeasuredVoiceTake[],
  rate = 1,
): Retimed {
  const cards = cardsOf(ir, lines);
  const texts: Array<string | undefined> = ir.scenes.map(() => undefined);
  const speech: Array<number | undefined> = ir.scenes.map(() => undefined);
  cards.forEach((card, i) => {
    texts[card] = lines[i]?.text;
    const said = speechOf(takes[i] as MeasuredVoiceTake);
    speech[card] = said === undefined ? undefined : Math.ceil(said / rate);
  });
  const neededMs = cardNeeds(texts, ir.language, speech).reduce((a, b) => a + b, 0);
  if (neededMs > ir.format.durationMs) return { neededMs };
  const cut = motionGraphicTemplate(source.brief, {
    assets: source.assets,
    storyboard: source.storyboard,
    speechMs: speech,
  });
  if (cut.scenes.length !== ir.scenes.length || cut.format.durationMs !== ir.format.durationMs) {
    throw new StudixError("INTERNAL", "Re-timing the cards to the voice takes changed the graphic's cards");
  }
  const next = replaceSfxTracks({
    ...ir,
    scenes: cut.scenes,
    timeline: cut.timeline,
    ...(cut.captions ? { captions: cut.captions } : {}),
  });
  const placed = voiceLines(next, 0, next.format.durationMs, false);
  if (placed.length !== lines.length) {
    throw new StudixError("INTERNAL", "Re-timing the cards to the voice takes changed the voice-over lines");
  }
  return {
    ir: next,
    lines: lines.map((line, i) => ({
      ...line,
      startMs: (placed[i] as VoiceLine).startMs,
      roomMs: (placed[i] as VoiceLine).roomMs,
    })),
  };
}

/**
 * Where the takes are laid: on the cards as they stand when every take fits its card, else on cards
 * re-timed to the takes at their own pace, else re-timed for the takes sped up to `MAX_VOICE_SPEEDUP`.
 * `neededMs` (sped up) when even that does not fit the graphic.
 */
function layout(
  ir: VideoIR,
  source: GraphicSource,
  lines: readonly VoiceLine[],
  takes: readonly MeasuredVoiceTake[],
): Retimed {
  if (lines.every((line, i) => fits(line, takes[i] as MeasuredVoiceTake))) return { ir, lines: [...lines] };
  const plain = retimed(ir, source, lines, takes);
  return "neededMs" in plain ? retimed(ir, source, lines, takes, MAX_VOICE_SPEEDUP) : plain;
}

/** The VALIDATION failure of takes that need more time than the whole graphic has. */
function tooLongError(
  ir: VideoIR,
  neededMs: number,
  lines: readonly VoiceLine[],
  takes: readonly MeasuredVoiceTake[],
): StudixError {
  const over = lines.flatMap((line, i) => {
    const speechMs = speechOf(takes[i] as MeasuredVoiceTake) ?? 0;
    return speechMs > line.roomMs
      ? [
          {
            line: i + 1,
            text: line.text.slice(0, 60),
            roomMs: line.roomMs,
            speechMs,
            overrunMs: speechMs - line.roomMs,
          },
        ]
      : [];
  });
  const named = over
    .slice(0, 4)
    .map((o) => `line ${o.line} "${o.text.slice(0, 40)}" by ${o.overrunMs} ms`)
    .join(", ");
  const totalMs = ir.format.durationMs;
  return new StudixError(
    "VALIDATION",
    `The voice-over takes need ${neededMs} ms with pads, even read ${MAX_VOICE_SPEEDUP}x faster, but the graphic is ${totalMs} ms (${neededMs - totalMs} ms over); past their cards: ${named || "none"}`,
    {
      retryable: false,
      details: { totalMs, neededMs, overMs: neededMs - totalMs, lines: over },
      suggestedAction: "Shorten the lines named, or lengthen the video, then create the graphic again.",
    },
  );
}

/**
 * `ir` with each line's words placed where its track plays them (the provider's word timings, else an
 * estimate over the take's measured speech) and the cards' reveals and captions put on those words.
 */
function spokenOn(
  ir: VideoIR,
  lines: readonly VoiceLine[],
  takes: readonly MeasuredVoiceTake[],
  tracks: readonly AudioTrack[],
): VideoIR {
  const cards = cardsOf(ir, lines);
  const spoken: CardWords[] = [];
  const texts = new Map<string, string>();
  lines.forEach((line, i) => {
    const scene = ir.scenes[cards[i] as number];
    const take = takes[i] as MeasuredVoiceTake;
    const track = tracks[i] as AudioTrack;
    if (!scene) return;
    const inFile =
      take.words ??
      estimateWords(
        line.text,
        take.measured ?? { startMs: 0, endMs: take.lengthMs ?? track.durationMs ?? line.roomMs },
        ir.language,
      );
    const words = placeWords(inFile, track);
    if (words.length === 0) return;
    spoken.push({ card: scene.id, words });
    texts.set(scene.id, line.text);
  });
  return spoken.length > 0 ? withSpokenWords(ir, spoken, texts) : ir;
}

/** Runs `work`, billing `spent` (and whatever `work` spent) when it fails. */
async function spending<T>(spent: readonly StageUsage[], work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const failed = err instanceof StageFailedAfterSpend;
    throw new StageFailedAfterSpend(failed ? err.error : toStudixError(err), [
      ...spent,
      ...(failed ? err.usage : []),
    ]);
  }
}

/**
 * Voice every line of a graphic, then lay the takes. Every take is measured (and stored) before any is
 * judged. When all fit their cards they are laid as the cards stand. When one runs past its card but all
 * the speech fits the graphic, the cards are re-timed to the takes (`layout`), so no re-take is paid for.
 * Only when the speech does not fit the graphic is each overrunning line voiced once more, brisker; if the
 * speech still does not fit, the stage fails VALIDATION naming the lines and by how much, all takes billed.
 */
export async function voiceGraphic(
  s: StageContext,
  stage: string,
  ir: VideoIR,
  source: GraphicSource,
  planned: readonly PlannedVoiceLine[],
  workDir: string,
  concurrency: number,
): Promise<{ ir: VideoIR; usage: StageUsage[] }> {
  // A re-take already stored (an earlier attempt) means the first take was too long: start from it.
  const firstTakes = await mapBounded(
    planned,
    concurrency,
    async (p) => {
      const retake = briskerTake(p.request);
      const request = (await hasStoredOutput(s, stage, retake)) ? retake : p.request;
      return measuredVoiceTake(s, stage, request, workDir);
    },
    (t) => [t.usage],
  );
  const takes = [...firstTakes];
  const spent = takes.map((t) => t.usage);
  const lines = planned.map((p) => p.line);
  return spending(spent, async () => {
    let plan = layout(ir, source, lines, takes);
    if ("neededMs" in plan) {
      const redo = planned.flatMap((p, i) =>
        !fits(p.line, takes[i] as MeasuredVoiceTake) && !takes[i]?.request.retry ? [i] : [],
      );
      const retakes = await mapBounded(
        redo,
        concurrency,
        (i) => measuredVoiceTake(s, stage, briskerTake((planned[i] as PlannedVoiceLine).request), workDir),
        (t) => [t.usage],
      );
      redo.forEach((i, k) => {
        const t = retakes[k] as MeasuredVoiceTake;
        takes[i] = t;
        spent.push(t.usage);
      });
      plan = layout(ir, source, lines, takes);
      if ("neededMs" in plan) throw tooLongError(ir, plan.neededMs, lines, takes);
    }
    const tracks = takes.map((t, i) =>
      voiceLineTrack(
        plan.lines[i] as VoiceLine,
        { ...t.asset, durationMs: t.lengthMs },
        `${t.request.assetId}-track`,
        t.measured,
      ),
    );
    const voiced = withVoiceover(
      plan.ir,
      tracks,
      takes.map((t) => t.asset),
    );
    return VideoIR.parse(spokenOn(voiced, plan.lines, takes, tracks));
  }).then((next) => ({ ir: next, usage: spent }));
}
