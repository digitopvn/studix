import { extname, join } from "node:path";
import type { GeneratedMedia } from "@studix/core";
import { measureAudibleSpan } from "@studix/renderers";
import { StudixError, toStudixError } from "@studix/shared";
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

/**
 * Names takes stored as measured but not judged in the reuse key: a stage that re-times its cards to the
 * takes it gets keeps every take, so such a take is never served as one that fits (`VOICE_FIT_SCOPE`).
 */
export const VOICE_TAKE_SCOPE = "voice-take@1";

/** The reuse scope of a line's unjudged takes, keyed by its exact room like `voiceFitScope`. */
export function voiceTakeScope(line: Pick<VoiceLine, "roomMs">): string {
  return `${VOICE_TAKE_SCOPE}:${line.roomMs}`;
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
export function briskerTake(request: StoredMediaRequest): StoredMediaRequest {
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

export interface VoiceTake {
  asset: AssetRef;
  track: AudioTrack;
  /** Every call made for the line, the turned-down take included. */
  usage: StageUsage[];
}

/**
 * Voice one line and lay it at its beat. The take is measured before it is stored, so its leading and
 * trailing silence do not count against the room. A take still too long to speed up into its room is
 * turned down (billed, never stored or reused) and the line is voiced once more with a brisker direction;
 * a second take too long fails VALIDATION with both calls billed. Cost estimates count one take per line:
 * the re-take is the exception, paid only when it is needed.
 */
export async function generateVoiceTake(
  s: StageContext,
  stage: string,
  line: VoiceLine,
  request: StoredMediaRequest,
  trackId: string,
  workDir: string,
  measure: VoiceTakeMeasure = measureVoiceTake,
): Promise<VoiceTake> {
  const spent: StageUsage[] = [];
  let last: Record<string, unknown> = { assetId: request.assetId };
  const retake = briskerTake(request);
  try {
    // A re-take already stored (an earlier attempt of this stage, or another job voicing the same line)
    // means the first take was turned down: start from the re-take instead of paying for it again.
    const takes = (await hasStoredOutput(s, stage, retake)) ? [retake] : [request, retake];
    for (const take of takes) {
      const probe: { checked: boolean; measured?: MeasuredTake } = { checked: false };
      const fits = async (filePath: string, output: GeneratedMedia) => {
        probe.checked = true;
        probe.measured = await measure(filePath, s.signal);
        // Unmeasured, the take is judged on the length the provider reported (accepted when it reported none).
        return probe.measured
          ? voiceTakeFits(line, probe.measured.durationMs, probe.measured)
          : voiceTakeFits(line, output.durationMs === undefined ? undefined : Math.round(output.durationMs));
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
      if ("rejected" in made || !voiceTakeFits(line, lengthMs, measured)) continue;
      // A take served from a provider cache may carry no length; the measured one still places its fade.
      const timed = { ...made.asset, durationMs: lengthMs };
      return { asset: made.asset, track: voiceLineTrack(line, timed, trackId, measured), usage: spent };
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
  throw new StageFailedAfterSpend(voiceOverrunError(line, last), spent);
}

/** A take kept whatever its length, with what it measured. */
export interface MeasuredVoiceTake {
  /** The request that made it: the line's own, or its brisker re-take. */
  request: StoredMediaRequest;
  asset: AssetRef;
  /** Its length: as stored, else as measured; undefined when neither is known. */
  lengthMs: number | undefined;
  measured: MeasuredTake | undefined;
  usage: StageUsage;
}

/**
 * Voice one line, store the take whatever its length and measure its speech, for a stage that judges every
 * take before it lays any (and re-times the cards to them). A stored take is reused, never paid twice: an
 * earlier attempt's journaled output, or an identical request's stored output, is measured from storage.
 */
export async function measuredVoiceTake(
  s: StageContext,
  stage: string,
  request: StoredMediaRequest,
  workDir: string,
  measure: VoiceTakeMeasure = measureVoiceTake,
): Promise<MeasuredVoiceTake> {
  const probe: { checked: boolean; measured?: MeasuredTake } = { checked: false };
  const made = await generateStoredMedia(s, stage, request, async (filePath) => {
    probe.checked = true;
    probe.measured = await measure(filePath, s.signal);
    return true;
  });
  // Never turned down: the check above accepts every take.
  if ("rejected" in made)
    throw new StageFailedAfterSpend(
      new StudixError("INTERNAL", "A voice take was turned down by a check that accepts all"),
      [made.usage],
    );
  try {
    const measured = probe.checked ? probe.measured : await measureStored(s, made.asset, workDir, measure);
    return {
      request,
      asset: made.asset,
      lengthMs: made.asset.durationMs ?? measured?.durationMs,
      measured,
      usage: made.usage,
    };
  } catch (err) {
    throw new StageFailedAfterSpend(toStudixError(err), [made.usage]);
  }
}
