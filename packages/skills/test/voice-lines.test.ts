import { StudixError } from "@studix/shared";
import type { AssetRef, VideoIR } from "@studix/video-ir";
import { describe, expect, it } from "vitest";
import { spokenLength } from "../src/caption-chunks.ts";
import { marketingScript } from "../src/marketing-video/marketing-script.ts";
import { beatKey, marketingVideoIr } from "../src/marketing-video/marketing-video-template.ts";
import { motionGraphicTemplate } from "../src/motion-graphic/motion-graphic-template.ts";
import {
  MAX_VOICE_DIRECTION_CHARS,
  MAX_VOICE_SPEEDUP,
  VOICE_LEAD_PAD_MS,
  VOICE_OVERRUN_TOLERANCE_MS,
  voiceLines,
  voiceLineTrack,
  withVoiceover,
} from "../src/voice-lines.ts";

const brand = {
  name: "Lá Mây",
  palette: { primary: "#2f5d50", accent: "#e0b354", background: "#f7f3ea", foreground: "#1c1c1c" },
  fonts: { heading: "Inter", body: "Inter" },
  voice: ["ấm áp", "tinh tế"],
};

const asset = (id: string, kind: AssetRef["kind"], durationMs?: number): AssetRef => ({
  id,
  kind,
  storageKey: `generated/job/${id}`,
  sha256: "a".repeat(64),
  mime: kind === "audio" ? "audio/wav" : "video/mp4",
  provenance: { source: "generated" },
  ...(durationMs === undefined ? {} : { durationMs }),
});
const take = (id: string, durationMs?: number) => asset(id, "audio", durationMs);

function adIr(cta = "Ghé Lá Mây hôm nay.") {
  const script = marketingScript({
    prompt: "Ads cho tiệm trà",
    language: "vi",
    durationMs: 20_000,
    directions: [
      {
        id: "morning",
        name: "Buổi sáng",
        concept: "Một tách trà buổi sáng",
        beats: [
          { visual: "ấm trà", onScreen: "Sáng nay uống trà chưa?", voiceover: "Sáng nay bạn uống trà chưa?" },
          { visual: "lá trà", voiceover: "Trà hái tay mỗi sớm, ủ chậm cho vị thanh." },
          { visual: "tiệm", onScreen: "Ghé Lá Mây", voiceover: cta },
        ],
      },
    ],
  });
  // The voice-over stage runs after image-to-video: every beat of the ad is one clip.
  const clips = Object.fromEntries(
    (script.ads[0]?.beats ?? []).map((b) => {
      const key = beatKey(script.ads[0]?.id ?? "", b.id);
      return [key, asset(`${key}-clip`, "video", 3000)];
    }),
  );
  return marketingVideoIr(script, undefined, "Lá Mây", { clips });
}

function graphicIr() {
  return motionGraphicTemplate({
    prompt: "Motion graphic giới thiệu tiệm trà Lá Mây",
    language: "vi",
    durationMs: 15_000,
    keyMessages: ["Trà hái tay mỗi sớm", "Hộp trà quà tặng"],
    callToAction: "Ghé Lá Mây hôm nay",
    brand,
  });
}

/** Where each beat of the IR starts: every scene, split at the start of each picture shot. */
function beatStarts(ir: VideoIR): number[] {
  let at = 0;
  const starts: number[] = [];
  for (const scene of ir.scenes) {
    const pictures = scene.shots.filter((sh) => sh.type === "image" || sh.type === "video");
    for (const s of new Set([0, ...pictures.map((sh) => sh.startMs)])) starts.push(at + s);
    at += scene.durationMs;
  }
  return starts.sort((a, b) => a - b);
}

describe("voice-over lines", () => {
  it("starts every line of an ad at its beat: hook after the lead-in, message and call to action on the cut", () => {
    const ir = adIr();
    const lines = voiceLines(ir, 0, 20_000);
    expect(lines.map((l) => l.startMs)).toEqual([300, 3000, 11_500]);
    expect(lines.map((l) => l.part)).toEqual(["hook", "message", "cta"]);
    expect(lines[2]?.text).toBe("Ghé Lá Mây hôm nay.");
    // No line runs into the next beat.
    expect(lines.map((l) => l.startMs + l.roomMs)).toEqual([3000, 11_500, 19_700]);
    expect(voiceLines(ir, 20_000, 40_000)).toEqual([]);
  });

  it("starts every line of a motion graphic at its card", () => {
    const ir = graphicIr();
    const lines = voiceLines(ir);
    const starts = beatStarts(ir);
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => l.part)).toEqual(["hook", "message", "message", "cta"]);
    // The first line waits for the lead-in; every other line starts on its card's cut.
    expect(lines[0]?.startMs).toBeGreaterThan(0);
    expect(lines[0]?.startMs).toBeLessThan(starts[1] as number);
    expect(lines.slice(1).map((l) => l.startMs)).toEqual(starts.slice(1));
    expect(lines.at(-1)?.text).toContain("Ghé Lá Mây hôm nay");
  });

  it("directs each line for its part, in the video's language and the brand's tone", () => {
    const lines = voiceLines(graphicIr());
    expect(lines[0]?.instructions).toContain("Line 1 of 4 of a short Vietnamese ad voice-over");
    expect(lines[0]?.instructions).toContain("Tone of voice: ấm áp, tinh tế.");
    expect(lines[0]?.instructions).toContain("lean in");
    expect(lines[1]?.instructions).toContain("Carry the message");
    expect(lines[3]?.instructions).toContain("call to action");
    expect(lines[3]?.instructions).not.toContain("Carry the message");
    for (const l of lines) {
      expect(l.instructions).toContain(`Say it in under ${(l.roomMs / 1000).toFixed(1)} seconds`);
      expect(l.instructions.length).toBeLessThanOrEqual(MAX_VOICE_DIRECTION_CHARS);
    }
  });

  it("keeps free-text brand keywords from breaking the direction", () => {
    const ir = motionGraphicTemplate({
      prompt: "Trà",
      language: "vi",
      durationMs: 12_000,
      keyMessages: ["Trà hái tay mỗi sớm"],
      brand: { ...brand, voice: ["ấm\náp", "a", "b", "c", "d", "e"] },
    });
    for (const l of voiceLines(ir)) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting that none are left.
      expect(l.instructions).not.toMatch(/[\u0000-\u001f]/);
      expect(l.instructions).toContain("Tone of voice: ấm áp, a, b, c.");
    }
  });

  it("refuses, before anything is paid, a line with more words than its beat holds", () => {
    const ir = adIr();
    const cues = ir.captions?.cues ?? [];
    const hook = cues.find((c) => c.endMs <= 3000);
    if (!hook) throw new Error("hook cue missing");
    hook.text = Array.from({ length: 30 }, () => "trà").join(" ");
    expect(() => voiceLines(ir, 0, 20_000)).toThrowError(StudixError);
    try {
      voiceLines(ir, 0, 20_000);
    } catch (e) {
      expect((e as StudixError).code).toBe("VALIDATION");
    }
  });

  it("keeps a line that exactly fills its room, whatever float rounding says", () => {
    const ir = adIr();
    const hook = (ir.captions?.cues ?? []).find((c) => c.endMs <= 3000);
    if (!hook) throw new Error("hook cue missing");
    // 5.7 words over 1900 ms: 1.9 * 3 is 5.699999… in floating point.
    hook.endMs = hook.startMs + 1900;
    hook.text = "bạn studio Studix dựng hơn";
    expect(spokenLength(hook.text, "vi")).toBe(5.7);
    expect(() => voiceLines(ir, 0, 20_000)).not.toThrow();
    // Sped up as far as the voice stage may, 1697ms still holds 1900ms of speech (floor(1697 × 1.12));
    // one millisecond less does not.
    hook.endMs = hook.startMs + 1697;
    expect(() => voiceLines(ir, 0, 20_000)).not.toThrow();
    hook.endMs = hook.startMs + 1696;
    expect(() => voiceLines(ir, 0, 20_000)).toThrow(/does not fit its beat/);
  });
});

describe("voice-over line tracks", () => {
  const [, message] = voiceLines(adIr(), 0, 20_000);
  if (!message) throw new Error("message line missing");

  it("lays a take at its beat's start, never past the beat", () => {
    expect(voiceLineTrack(message, take("vo-2", 4200), "vo-2-track")).toEqual({
      id: "vo-2-track",
      kind: "voiceover",
      assetId: "vo-2",
      startMs: 3000,
      durationMs: 4200,
      volume: 1,
    });
    const breath = voiceLineTrack(message, take("vo-2", message.roomMs + 100), "t");
    expect(breath.startMs + (breath.durationMs ?? 0)).toBe(11_500);
    expect(breath.fadeOutMs).toBeGreaterThan(0);
    expect(voiceLineTrack(message, take("vo-2"), "t").durationMs).toBe(message.roomMs);
  });

  it("speeds up a slightly long take so the whole line lands inside its beat", () => {
    const long = take("vo-2", message.roomMs + VOICE_OVERRUN_TOLERANCE_MS + 1);
    const track = voiceLineTrack(message, long, "t");
    expect(track).toMatchObject({ startMs: message.startMs, durationMs: message.roomMs });
    expect(track.playbackRate).toBeGreaterThan(1);
    expect(track.playbackRate).toBeLessThanOrEqual(MAX_VOICE_SPEEDUP);
    expect(track.fadeOutMs).toBeGreaterThan(0);
  });

  it("fails VALIDATION on a take too long to speed up into its beat", () => {
    const long = take("vo-2", Math.ceil(message.roomMs * MAX_VOICE_SPEEDUP) + 10);
    expect(() => voiceLineTrack(message, long, "t")).toThrowError(/runs past its beat/);
  });

  it("judges a measured take on its speech: silence is trimmed, not sped up", () => {
    const room = { ...message, roomMs: 1800 };
    // 2116 ms with 200 ms of silence before the speech and 150 ms after it: too long as a file.
    const file = take("vo-1", 2116);
    expect(() => voiceLineTrack(room, file, "t")).toThrowError(/runs past its beat/);
    const track = voiceLineTrack(room, file, "t", { startMs: 200, endMs: 1966 });
    expect(track).toMatchObject({ durationMs: 1800, trimStartMs: 200 - VOICE_LEAD_PAD_MS });
    expect(track.playbackRate).toBeLessThanOrEqual(MAX_VOICE_SPEEDUP);
    // Speech that fits plays at its pace, cut in the trailing silence with a fade clear of the last word.
    const fits = voiceLineTrack(room, file, "t", { startMs: 200, endMs: 1700 });
    expect(fits).toMatchObject({ durationMs: 1800, trimStartMs: 140, fadeOutMs: 150 });
    expect(fits.playbackRate).toBeUndefined();
    // A measured take gets no breath of tolerance: its speech past the room is sped up.
    expect(voiceLineTrack(room, take("vo-1", 1900), "t", { startMs: 0, endMs: 1900 }).playbackRate).toBe(
      1.056,
    );
  });

  it("replaces every earlier voice-over track and its asset, keeping the rest of the mix", () => {
    const ir = adIr();
    const before: VideoIR = {
      ...ir,
      assets: [...ir.assets, take("ad-vo", 9000), take("ad-music", 20_000)],
      audio: [
        { id: "ad-vo-track", kind: "voiceover", assetId: "ad-vo", startMs: 300, volume: 1 },
        { id: "ad-music-track", kind: "music", assetId: "ad-music", startMs: 0, volume: 0.35 },
      ],
    };
    const line = take("ad-vo-2", 3000);
    const next = withVoiceover(before, [voiceLineTrack(message, line, "ad-vo-2-track")], [line]);
    expect(next.audio?.map((t) => [t.id, t.startMs])).toEqual([
      ["ad-vo-2-track", 3000],
      ["ad-music-track", 0],
    ]);
    expect(next.assets.map((a) => a.id)).not.toContain("ad-vo");
    expect(next.assets.map((a) => a.id)).toEqual(expect.arrayContaining(["ad-music", "ad-vo-2"]));
  });
});
