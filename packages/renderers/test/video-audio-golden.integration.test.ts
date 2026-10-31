import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRenderSpec, unwrapValidation, type VideoIR, validateVideoIR } from "@studix/video-ir";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FfmpegProbe,
  finishDeliveries,
  HyperFramesRenderer,
  LOUDNESS_TARGET,
  measureLoudness,
  mixAudio,
  normalizeLoudness,
} from "../src/index.ts";
import { renderToolchain, tempDir } from "./render-test-helpers.ts";

const toolchain = renderToolchain();
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((c) => c()));
});

/** Runs ffmpeg with an argv array and returns raw stdout (frames are binary). */
function ffmpeg(args: string[]): Buffer {
  const result = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-v", "error", ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout;
}

/** Sample media made from lavfi sources: no provider, no network. */
function makeMedia(dir: string): Record<string, string> {
  const files = {
    clip: join(dir, "clip.mp4"),
    bg: join(dir, "bg.mp4"),
    music: join(dir, "music.m4a"),
    voice: join(dir, "voice.wav"),
    sfx: join(dir, "sfx.wav"),
  };
  // Solid red clip with a 440 Hz tone: the shot's picture and its own sound are both checkable.
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=320x568:r=30:d=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=3",
    "-c:v",
    "libx264",
    "-g",
    "15",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    files.clip,
  ]);
  // Moving test pattern without sound: a background must play, not freeze on its first frame.
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x568:r=30:d=3",
    "-c:v",
    "libx264",
    "-g",
    "15",
    "-pix_fmt",
    "yuv420p",
    files.bg,
  ]);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "anoisesrc=color=pink:amplitude=0.3:duration=6:sample_rate=48000",
    "-ac",
    "2",
    "-c:a",
    "aac",
    files.music,
  ]);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:sample_rate=48000:duration=2",
    "-af",
    "volume=0.5",
    files.voice,
  ]);
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=1200:sample_rate=48000:duration=0.4", files.sfx]);
  return files;
}

function asset(id: string, kind: "video" | "audio", mime: string, file: string) {
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  return {
    id,
    kind,
    mime,
    sha256,
    storageKey: `assets/${id}/v1/${id}`,
    provenance: { source: "upload" as const },
  };
}

/** 9:16, 4 s at 30 fps: a red video shot (with sound) then a video background, plus voice, music and SFX. */
function goldenIr(files: Record<string, string>): VideoIR {
  return unwrapValidation(
    validateVideoIR({
      schemaVersion: 1,
      title: "Video và âm thanh",
      language: "vi",
      format: { aspectRatio: "9:16", width: 1080, height: 1920, fps: 30, durationMs: 4000 },
      assets: [
        asset("clip", "video", "video/mp4", files.clip!),
        asset("bg", "video", "video/mp4", files.bg!),
        asset("music", "audio", "audio/mp4", files.music!),
        asset("voice", "audio", "audio/wav", files.voice!),
        asset("sfx", "audio", "audio/wav", files.sfx!),
      ],
      scenes: [
        {
          id: "clip-scene",
          role: "hook",
          durationMs: 2000,
          shots: [
            {
              id: "red-clip",
              type: "video",
              assetId: "clip",
              startMs: 0,
              durationMs: 2000,
              trimStartMs: 500,
              fit: "cover",
              style: { region: "full" },
            },
          ],
        },
        {
          id: "bg-scene",
          role: "outro",
          durationMs: 2000,
          background: { assetId: "bg" },
          shots: [
            {
              id: "caption",
              type: "text",
              startMs: 0,
              durationMs: 2000,
              text: "Cảm ơn",
              style: { region: "top" },
            },
          ],
        },
      ],
      timeline: {
        entries: [
          { sceneId: "clip-scene", startMs: 0 },
          { sceneId: "bg-scene", startMs: 2000 },
        ],
      },
      audio: [
        {
          id: "bed",
          kind: "music",
          assetId: "music",
          startMs: 0,
          volume: 0.5,
          fadeInMs: 300,
          fadeOutMs: 500,
        },
        { id: "line", kind: "voiceover", assetId: "voice", startMs: 500, durationMs: 1500, volume: 1 },
        { id: "hit", kind: "sfx", assetId: "sfx", startMs: 2500, volume: 0.8 },
      ],
    }),
    "golden video+audio IR",
  );
}

/** Mean RGB of one frame at `atSec`. */
function frameColor(file: string, atSec: number): [number, number, number] {
  const px = ffmpeg([
    "-ss",
    String(atSec),
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    "scale=1:1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]);
  return [px[0]!, px[1]!, px[2]!];
}

/** Hash of a small grey thumbnail of one frame, to tell whether the picture moves. */
function frameHash(file: string, atSec: number): string {
  const px = ffmpeg([
    "-ss",
    String(atSec),
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    "scale=32:56",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    "-",
  ]);
  return createHash("sha1").update(px).digest("hex");
}

describe.skipIf(!toolchain.ok)(
  `golden render with video shots and multi-track audio${toolchain.ok ? "" : ` (skipped: ${toolchain.reason})`}`,
  () => {
    const probe = new FfmpegProbe();
    let dir = "";
    let files: Record<string, string> = {};

    beforeAll(async () => {
      const temp = await tempDir("golden-av");
      cleanups.push(temp.cleanup);
      dir = temp.dir;
      files = makeMedia(dir);
    });

    it("renders the IR to a master, preview and phone MP4 at -14 LUFS / -1.5 dBTP", async () => {
      const ir = goldenIr(files);
      const renderer = new HyperFramesRenderer({ workers: 1 });
      const output = await renderer.render(ir, {
        spec: resolveRenderSpec("final", { scale: 0.5, fps: 30 }),
        workDir: join(dir, "render"),
        assetFiles: {
          clip: files.clip!,
          bg: files.bg!,
          music: files.music!,
          voice: files.voice!,
          sfx: files.sfx!,
        },
        finish: { grade: "warm" },
      });

      // Master: exact frame count, fps, duration, one AAC stream.
      const facts = await probe.streamFacts(output.filePath);
      expect(facts).toEqual({ videoFrames: 120, fps: 30, audioStreams: 1 });
      expect(output.probe).toMatchObject({ width: 540, height: 960, videoCodec: "h264", audioCodec: "aac" });
      expect(Math.abs(output.probe.durationMs - 4000)).toBeLessThanOrEqual(50);

      // Loudness measured independently on the delivered file with a loudnorm analysis pass.
      const loudness = await measureLoudness(output.filePath, {});
      expect(Math.abs(loudness.integratedLufs - LOUDNESS_TARGET.integratedLufs)).toBeLessThanOrEqual(1);
      expect(loudness.truePeakDbtp).toBeLessThanOrEqual(LOUDNESS_TARGET.truePeakDbtp);

      // Deliveries: master first, a light preview and a 9:16 phone copy, each measured in spec.
      expect(output.deliveries?.map((d) => d.kind)).toEqual(["master", "preview", "phone"]);
      for (const delivery of output.deliveries ?? []) {
        expect(existsSync(delivery.filePath)).toBe(true);
        expect(Math.abs(delivery.probe.durationMs - 4000)).toBeLessThanOrEqual(50);
        expect(delivery.probe.audioCodec).toBe("aac");
        expect(Math.abs(delivery.loudness!.integratedLufs + 14)).toBeLessThanOrEqual(1);
        expect(delivery.loudness!.truePeakDbtp).toBeLessThanOrEqual(-1.5);
        expect(delivery.probe.width / delivery.probe.height).toBeCloseTo(9 / 16, 2);
      }
      const preview = output.deliveries![1]!;
      expect(Math.max(preview.probe.width, preview.probe.height)).toBeLessThanOrEqual(640);
      expect(preview.probe.bytes).toBeLessThan(output.probe.bytes);

      // The video shot shows its own frames (red), and the background plays rather than freezing.
      const [r, g, b] = frameColor(output.filePath, 1.0);
      expect(r).toBeGreaterThan(150);
      expect(r - Math.max(g, b)).toBeGreaterThan(80);
      expect(frameHash(output.filePath, 2.4)).not.toBe(frameHash(output.filePath, 3.6));

      // Scratch files are gone; only deliveries remain next to the composition.
      expect(existsSync(join(dir, "render", "capture.raw.mp4"))).toBe(false);
      expect(existsSync(join(dir, "render", "mix.norm.wav"))).toBe(false);
    }, 240_000);

    it("holds the true-peak ceiling on a transient-heavy mix that linear gain alone would clip", async () => {
      const work = join(dir, "peaky");
      const clicks = join(dir, "clicks.wav");
      const picture = join(dir, "picture.mp4");
      // Full-scale 5 ms clicks over a quiet tone: ~25 dB crest, so +14 dB of gain cannot stay linear.
      ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "aevalsrc='if(lt(mod(t,0.5),0.005),0.99,0.03*sin(2*PI*330*t))':s=48000:d=4",
        "-ac",
        "2",
        clicks,
      ]);
      ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "color=c=gray:s=360x640:r=30:d=4",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        picture,
      ]);
      const clip = {
        id: "c",
        kind: "sfx" as const,
        file: clicks,
        startMs: 0,
        durationMs: 4000,
        trimStartMs: 0,
        volume: 1,
        fadeInMs: 0,
        fadeOutMs: 0,
      };
      await mixAudio([clip], 4000, join(work, "mix.wav"), {});
      const measured = await normalizeLoudness(join(work, "mix.wav"), join(work, "norm.wav"), {});
      // Plain gain to -14 LUFS would push the peaks well over the ceiling.
      expect(
        measured!.truePeakDbtp + (LOUDNESS_TARGET.integratedLufs - measured!.integratedLufs),
      ).toBeGreaterThan(0);
      const delivered = await finishDeliveries(
        {
          video: picture,
          audio: join(work, "norm.wav"),
          outDir: work,
          name: "peaky",
          durationMs: 4000,
          aspectRatio: "9:16",
          crf: 23,
          extras: ["preview", "phone"],
        },
        {},
      );
      for (const file of delivered) {
        const m = await measureLoudness(file.filePath, {});
        expect(m.truePeakDbtp).toBeLessThanOrEqual(-1.5);
        expect(Math.abs(m.integratedLufs + 14)).toBeLessThanOrEqual(1);
      }
    }, 120_000);

    it("keeps a preview render to the master only and leaves a silent IR without loudness", async () => {
      const ir = goldenIr(files);
      ir.audio = [];
      for (const scene of ir.scenes)
        for (const shot of scene.shots) if (shot.type === "video") shot.muted = true;
      const output = await new HyperFramesRenderer({ workers: 1 }).render(ir, {
        spec: resolveRenderSpec("preview", { fps: 30 }),
        workDir: join(dir, "render-silent"),
        assetFiles: { clip: files.clip!, bg: files.bg! },
      });
      expect(output.deliveries?.map((d) => d.kind)).toEqual(["master"]);
      expect(output.deliveries![0]!.loudness).toBeUndefined();
      expect(await probe.streamFacts(output.filePath)).toEqual({
        videoFrames: 120,
        fps: 30,
        audioStreams: 1,
      });
    }, 240_000);
  },
);
