import { resolveSceneSpans, type VideoIR } from "@studix/video-ir";

/** What a stretch of the voice-over does in the video, which sets how it is read. */
export type VoicePart = "hook" | "message" | "cta";

const DIRECTION: Readonly<Record<VoicePart, string>> = {
  hook: "open with an intrigued, bright energy that makes the listener lean in",
  message: "carry the message warmly and assuredly, like telling a friend about something you love",
  cta: "land the call to action with an inviting smile in the voice, unhurried",
};

const DEFAULT_TONE = ["warm", "confident"];
/** Brand tone keywords quoted in the direction; the rest only lengthen it. */
const MAX_TONE_WORDS = 4;
/** Speech routes accept at most this much direction (see the providers' voice params). */
export const MAX_VOICE_DIRECTION_CHARS = 1000;

/** The part a moment of the video plays: its scene's role, else the copy on screen at that moment. */
function partAt(ir: VideoIR, atMs: number): VoicePart {
  const span = resolveSceneSpans(ir.timeline, ir.scenes).find((s) => atMs >= s.startMs && atMs < s.endMs);
  const scene = span ? ir.scenes.find((s) => s.id === span.sceneId) : undefined;
  if (!span || !scene) return "message";
  if (scene.role === "cta" || scene.role === "outro") return "cta";
  if (scene.role === "hook" || scene.role === "intro") return "hook";
  const t = atMs - span.startMs;
  const showing = scene.shots.filter((sh) => sh.startMs <= t && t < sh.startMs + sh.durationMs);
  if (showing.some((sh) => sh.type === "cta" || sh.type === "logo")) return "cta";
  if (showing.some((sh) => sh.type === "title")) return "hook";
  return "message";
}

function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/**
 * Delivery direction for the voice-over spoken in [fromMs, toMs): its language, the brand's tone of voice
 * and how each part is read (hook, message, call to action) in the order the captions speak them. The
 * first line is always read as the hook. Undefined when no caption falls in the span. Pure: the same IR
 * gives the same direction, so it is safe inside a stage's cached input.
 */
export function voiceDirection(ir: VideoIR, fromMs = 0, toMs = ir.format.durationMs): string | undefined {
  const cues = (ir.captions?.cues ?? []).filter((c) => c.startMs >= fromMs && c.endMs <= toMs);
  if (cues.length === 0) return undefined;
  const parts: VoicePart[] = [];
  for (const [i, cue] of cues.entries()) {
    // The middle of the line: a card such as the CTA lands a moment after its line starts.
    const at = partAt(ir, (cue.startMs + cue.endMs) / 2);
    const part = i === 0 && at === "message" ? "hook" : at;
    if (parts.at(-1) !== part) parts.push(part);
  }
  const tone = (ir.brand?.voice?.length ? ir.brand.voice : DEFAULT_TONE).slice(0, MAX_TONE_WORDS).join(", ");
  const flow = parts.map((p) => DIRECTION[p]).join("; then ");
  return (
    [
      `Voice-over for a short ${languageName(ir.language)} ad, read by a native speaker.`,
      `Tone of voice: ${tone}.`,
      "Sound like a real person who means every word, never flat, monotone or robotic.",
      `${flow.charAt(0).toUpperCase()}${flow.slice(1)}.`,
      "Natural conversational pace with a short breath between sentences; say the brand name clearly.",
    ]
      .join(" ")
      // Brand keywords are free text; speech routes refuse control characters in direction.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed.
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .slice(0, MAX_VOICE_DIRECTION_CHARS)
  );
}
