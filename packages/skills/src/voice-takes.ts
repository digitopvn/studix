import { extname, join } from "node:path";
import { measureAudibleSpan } from "@studix/renderers";
import { toStudixError } from "@studix/shared";
import type { AssetRef, AudioTrack } from "@studix/video-ir";
import { requireService, type StageContext, StageFailedAfterSpend, type StageUsage } from "@studix/workflow";
import { generateStoredMedia, type StoredMediaRequest } from "./stored-media.ts";
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
 * its room, is never served as a take that fits. The room is in the request's direction, so it is keyed too.
 */
export const VOICE_FIT_SCOPE = "voice-fits@1";

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
  return {
    ...request,
    params: {
      ...request.params,
      instructions: `${BRISKER_DIRECTION} ${direction}`.trim().slice(0, MAX_VOICE_DIRECTION_CHARS),
    },
    keyPrefix: `${request.keyPrefix}-r1`,
    retry: 1,
  };
}

/**
 * Measure a take served from storage (an earlier attempt's journaled output, or another job's reused one):
 * its scratch file may be gone, so the stored object is fetched into `workDir`.
 */
async function measureStored(
  s: StageContext,
  asset: AssetRef,
  workDir: string,
  measure: VoiceTakeMeasure,
): Promise<MeasuredTake | undefined> {
  if (!asset.storageKey) return undefined;
  const file = join(workDir, `${asset.id}-take${extname(asset.storageKey)}`);
  await requireService(s, "storage").download(s.ctx, asset.storageKey, file);
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
  try {
    for (const take of [request, briskerTake(request)]) {
      const probe: { checked: boolean; measured?: MeasuredTake } = { checked: false };
      const fits = async (filePath: string) => {
        probe.checked = true;
        probe.measured = await measure(filePath, s.signal);
        return probe.measured === undefined || voiceTakeFits(line, probe.measured.durationMs, probe.measured);
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
      return { asset: made.asset, track: voiceLineTrack(line, made.asset, trackId, measured), usage: spent };
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
