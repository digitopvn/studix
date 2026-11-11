import { extname, join } from "node:path";
import type { GeneratedMedia } from "@studix/core";
import { measureAudibleSpan } from "@studix/renderers";
import { toStudixError } from "@studix/shared";
import type { AssetRef, AudioTrack } from "@studix/video-ir";
import { requireService, type StageContext, StageFailedAfterSpend, type StageUsage } from "@studix/workflow";
import { generateStoredMedia, hasStoredOutput, type StoredMediaRequest } from "./stored-media.ts";
import {
  MAX_VOICE_DIRECTION_CHARS,
  type SpokenSpan,
  type VoiceLine,
  voiceLineTrack,
  voiceOverrunError,
  voiceTakeFits,
} from "./voice-lines.ts";

/** A take file's decoded length and where its speech starts and ends. */
export interface MeasuredTake extends SpokenSpan {
  durationMs: number;
}

/** Measures a take file; undefined when it has nothing to measure or cannot be read. */
export type VoiceTakeMeasure = (filePath: string, signal: AbortSignal) => Promise<MeasuredTake | undefined>;

/**
 * Names the fit check in the reuse key of a voice request: a take stored without it, or one too long for
 * its room, is never served as a take that fits.
 */
export const VOICE_FIT_SCOPE = "voice-fits@1";

/**
 * The reuse scope of a line's takes, keyed by its exact room: a take (or re-take) that fit one room is only
 * reused for that same room, never for a slightly shorter one whose direction rounds to the same seconds.
 */
export function voiceFitScope(line: Pick<VoiceLine, "roomMs">): string {
  return `${VOICE_FIT_SCOPE}:${line.roomMs}`;
}

const BRISKER_DIRECTION =
  "The previous read ran too long for its slot: read this one noticeably brisker with short pauses, " +
  "still natural, and say the brand name clearly.";

/**
 * The speech span of a take, from FFmpeg. Measuring refines where the take is laid; a file FFmpeg cannot read
 * (or a worker without FFmpeg) leaves the take judged on its whole length, as a take was before measuring.
 */
export const measureVoiceTake: VoiceTakeMeasure = async (filePath, signal) => {
  try {
    return await measureAudibleSpan(filePath, { ffmpegPath: process.env.FFMPEG_PATH, signal });
  } catch (err) {
    if (signal.aborted) throw err;
    return undefined;
  }
};

/** The one re-take of a line: brisker direction, and its own idempotency key, usage line and object. */
function briskerTake(request: StoredMediaRequest): StoredMediaRequest {
  const direction = typeof request.params?.instructions === "string" ? request.params.instructions : "";
  // The line's own direction gives way, never the brisker ask that leads.
  const kept = direction.slice(0, MAX_VOICE_DIRECTION_CHARS - BRISKER_DIRECTION.length - 1);
  return {
    ...request,
    params: { ...request.params, instructions: `${BRISKER_DIRECTION} ${kept}`.trim() },
    keyPrefix: `${request.keyPrefix}-r1`,
    retry: 1,
  };
}

/**
 * Measure a take served from storage (an earlier attempt's journaled output, or another job's reused one):
 * its scratch file may be gone, so the stored object is fetched into `workDir`. A fetch that fails leaves
 * the take judged on its whole length, like a file FFmpeg cannot read.
 */
async function measureStored(
  s: StageContext,
  asset: AssetRef,
  workDir: string,
  measure: VoiceTakeMeasure,
): Promise<MeasuredTake | undefined> {
  if (!asset.storageKey) return undefined;
  const file = join(workDir, `${asset.id}-take${extname(asset.storageKey)}`);
  try {
    await requireService(s, "storage").download(s.ctx, asset.storageKey, file);
  } catch (err) {
    if (s.signal.aborted) throw err;
    return undefined;
  }
  return measure(file, s.signal);
}

/** A take of a line, measured: its asset, its length and its speech span when known. */
export interface MeasuredVoiceTake {
  asset: AssetRef;
  /** The take's length: the provider's figure, else the decoded one. */
  lengthMs?: number;
  span?: SpokenSpan;
  /** Every call made for the line, a turned-down take included. */
  usage: StageUsage[];
}

export interface VoiceTake extends MeasuredVoiceTake {
  track: AudioTrack;
}

export interface TakeVoiceLineOptions {
  /**
   * The room a take is judged against; the line's own by default. A pack that can re-time its beats
   * passes more, so a take a little long for its beat is kept and its beat made longer instead.
   */
  roomMs?: number;
  /** Only the brisker re-take: the first take was kept but the beats could not make room for it. */
  briskerOnly?: boolean;
}

/**
 * Voice one line and measure it. The take is measured before it is stored, so its leading and trailing
 * silence do not count against the room. A take still too long to speed up into the room is turned down
 * (billed, never stored or reused) and the line is voiced once more with a brisker direction; a second take
 * too long fails VALIDATION with both calls billed. Cost estimates count one take per line: the re-take is
 * the exception, paid only when it is needed.
 */
export async function takeVoiceLine(
  s: StageContext,
  stage: string,
  line: VoiceLine,
  request: StoredMediaRequest,
  workDir: string,
  measure: VoiceTakeMeasure = measureVoiceTake,
  options: TakeVoiceLineOptions = {},
): Promise<MeasuredVoiceTake> {
  const room: VoiceLine = options.roomMs === undefined ? line : { ...line, roomMs: options.roomMs };
  const spent: StageUsage[] = [];
  let last: Record<string, unknown> = { assetId: request.assetId };
  const retake = briskerTake(request);
  try {
    // A re-take already stored (an earlier attempt of this stage, or another job voicing the same line)
    // means the first take was turned down: start from the re-take instead of paying for it again.
    const takes =
      options.briskerOnly || (await hasStoredOutput(s, stage, retake)) ? [retake] : [request, retake];
    for (const take of takes) {
      const probe: { checked: boolean; measured?: MeasuredTake } = { checked: false };
      const fits = async (filePath: string, output: GeneratedMedia) => {
        probe.checked = true;
        probe.measured = await measure(filePath, s.signal);
        // Unmeasured, the take is judged on the length the provider reported (accepted when it reported none).
        return probe.measured
          ? voiceTakeFits(room, probe.measured.durationMs, probe.measured)
          : voiceTakeFits(room, output.durationMs === undefined ? undefined : Math.round(output.durationMs));
      };
      const made = await generateStoredMedia(s, stage, take, fits);
      spent.push(made.usage);
      if (!("rejected" in made) && !probe.checked) {
        probe.measured = await measureStored(s, made.asset, workDir, measure);
      }
      const measured = probe.measured;
      const lengthMs =
        "rejected" in made ? measured?.durationMs : (made.asset.durationMs ?? measured?.durationMs);
      last = {
        assetId: request.assetId,
        takes: spent.length,
        durationMs: lengthMs,
        ...(measured ? { speechStartMs: measured.startMs, speechEndMs: measured.endMs } : {}),
      };
      if ("rejected" in made || !voiceTakeFits(room, lengthMs, measured)) continue;
      const span = measured ? { startMs: measured.startMs, endMs: measured.endMs } : undefined;
      return {
        asset: made.asset,
        ...(lengthMs !== undefined ? { lengthMs } : {}),
        ...(span ? { span } : {}),
        usage: spent,
      };
    }
  } catch (err) {
    if (spent.length === 0) throw err;
    // Whatever stopped this take (cancel, deadline, provider error), the earlier take was already paid.
    const failed = err instanceof StageFailedAfterSpend;
    throw new StageFailedAfterSpend(failed ? err.error : toStudixError(err), [
      ...spent,
      ...(failed ? err.usage : []),
    ]);
  }
  throw new StageFailedAfterSpend(voiceOverrunError(room, last), spent);
}

/** Voice one line (`takeVoiceLine`) and lay it at its beat. */
export async function generateVoiceTake(
  s: StageContext,
  stage: string,
  line: VoiceLine,
  request: StoredMediaRequest,
  trackId: string,
  workDir: string,
  measure: VoiceTakeMeasure = measureVoiceTake,
): Promise<VoiceTake> {
  const take = await takeVoiceLine(s, stage, line, request, workDir, measure);
  return { ...take, track: voiceLineTrack(line, timedAsset(take), trackId, take.span) };
}

/**
 * The take's asset with its length: a take served from a provider cache may carry none, and the measured
 * one still places its fade.
 */
export function timedAsset(take: MeasuredVoiceTake): AssetRef {
  return { ...take.asset, durationMs: take.lengthMs };
}
