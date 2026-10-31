import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AssetRef, unwrapValidation, type VideoIR, validateVideoIR } from "@studix/video-ir";
import {
  FILM_ENGINE_VERSION,
  FILM_SCENE_FORMAT,
  FILM_SCENE_MIME,
  type FilmScenePackage,
} from "../src/index.ts";

/**
 * A small film scene that touches every part of the ported engine: a multiplane set flown by a camera path
 * (gl shot), a cel push-in with a cross-dissolve, petal weather, a spark hit with a glint, the DOM edit kit
 * (camera, shake, flash, whip) and a karaoke caption with a translation. 320x180 at 12 fps keeps a software
 * WebGL capture fast.
 */
export const FILM_SCENE_MODULE = `
import { seg, lerp, easeInOut, pulse } from "engine/core/film-constants.js";
import params from "params";

export const scene = {
  sets: {
    main: {
      dir: ".", fov: 40, overscan: 1.16, hazeColor: [0.86, 0.9, 0.97],
      layers: [
        ["asset:set-base", 90, [0, 0, 1000, 1000], 0.0, 1.32],
        ["asset:set-fg", 8, [0, 600, 1000, 1000], 0.8],
      ],
    },
  },
  cards: { main: [] },
  weather: {
    preset: "petal", count: 600,
    defaults: { swirl: 0.45 },
    perShot: { s01: { density: 0.4, size: 0.2, wind: [0.5, -0.35, 4.2] }, s02: { density: 0.25, size: 0.18 } },
  },
  cels: { s02: { zoom: [1.0, 1.08], focus: [0.6, 0.55] } },
  cameras: {
    s01: (t, shot) => {
      const k = easeInOut(seg(t, shot.start, shot.end));
      return { z: lerp(0.6, -4.0, k), y: lerp(-0.3, 0.4, k), roll: lerp(-2, 1, k), focus: lerp(9, 20, k) };
    },
  },
  sparks: [[120, 3], [80, 11]],
};

export function fxCues(t, shot, { glow, sparks, map }) {
  if (shot.id === "s01") {
    glow.flash([0.4, 0.3], 0.8 * pulse(t, 0.9, 0.08));
    sparks[0].fire(t - 0.9, [0.4, 0.3], { speed: 1.6, life: 0.5, gravity: 1.3, drag: 3, size: 0.006, tint: [1, 0.78, 0.5], intensity: 1.3 });
  }
  if (shot.id === "s02") glow.glint(0, map([0.2, 0.1]), 0.25, 0.3, [1, 0.95, 0.92], 1.2 * pulse(t, 1.7, 0.2));
}

export function editCues(k) {
  k.cam("s01", { scale: 1.0 }, { scale: params.push ?? 1.04 });
  k.flash(0.9, 0.3, 0.12);
  k.shake(0.9, 0.4, 4, { seed: 7 });
  k.whipIn(k.at("s02"), 30, 0.1);
  k.cam("s02", {}, { scale: 1.03, x: -6 }, "sine.out");
}
`;

export function filmScenePackage(): FilmScenePackage {
  return {
    format: FILM_SCENE_FORMAT,
    engine: FILM_ENGINE_VERSION,
    lang: "vi",
    edl: {
      fps: 12,
      duration: 2.5,
      width: 320,
      height: 180,
      fade: { in: 0.2, out: 0.2 },
      captions: { highlight: "#ffe08a", hold: 0.15 },
      speakers: { a: { name: "A", color: "#ffd6e2" } },
      shots: [
        {
          id: "s01",
          kind: "gl",
          set: "main",
          start: 0,
          end: 1.25,
          dialogue: [
            {
              speaker: "a",
              t0: 0.3,
              t1: 1.1,
              text: "Ready now",
              tr: "Sẵn sàng",
              words: [
                { text: "Ready", t0: 0.3 },
                { text: "now", t0: 0.7 },
              ],
            },
          ],
        },
        { id: "s02", kind: "cel", start: 1.25, end: 2.5, img: "asset:cel-a", xfade: 0 },
      ],
    },
    module: FILM_SCENE_MODULE,
  };
}

function ffmpeg(args: string[]): void {
  const result = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-v", "error", "-y", ...args]);
  if (result.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Writes the scene's media (made with ffmpeg lavfi, no network) and its code asset; returns the IR inputs. */
export async function writeFilmSceneAssets(
  dir: string,
  pkg: FilmScenePackage = filmScenePackage(),
): Promise<{ assets: AssetRef[]; assetFiles: Record<string, string> }> {
  const files = {
    "set-base": join(dir, "set-base.png"),
    "set-fg": join(dir, "set-fg.png"),
    "cel-a": join(dir, "cel-a.png"),
    "scene-a": join(dir, "scene-a.json"),
  };
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "gradients=s=640x360:c0=0x203a6b:c1=0xf0a060:seed=4",
    "-frames:v",
    "1",
    files["set-base"],
  ]);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=0x0a1a10:s=640x160,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(Y,40+20*sin(X/40)),255,0)'",
    "-frames:v",
    "1",
    files["set-fg"],
  ]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=640x360", "-frames:v", "1", files["cel-a"]]);
  await writeFile(files["scene-a"], JSON.stringify(pkg));
  const image = (id: "set-base" | "set-fg" | "cel-a"): AssetRef => ({
    id,
    kind: "image",
    storageKey: `test/${id}.png`,
    sha256: sha256File(files[id]),
    mime: "image/png",
    provenance: { source: "upload" },
  });
  return {
    assets: [
      image("set-base"),
      image("set-fg"),
      image("cel-a"),
      {
        id: "scene-a",
        kind: "code",
        storageKey: "test/scene-a.json",
        sha256: sha256File(files["scene-a"]),
        mime: FILM_SCENE_MIME,
        assetVersionId: "asv_scene_a_1",
        provenance: { source: "generated" },
      },
    ],
    assetFiles: { ...files },
  };
}

/** A 16:9 IR whose only shot is the film scene (validated). */
export function filmSceneIr(assets: AssetRef[], params?: Record<string, number>): VideoIR {
  return unwrapValidation(
    validateVideoIR({
      schemaVersion: 1,
      title: "Film scene golden",
      language: "vi",
      format: { aspectRatio: "16:9", width: 320, height: 180, fps: 12, durationMs: 2500 },
      assets,
      scenes: [
        {
          id: "scene-1",
          role: "body",
          durationMs: 2500,
          shots: [
            {
              id: "film",
              type: "composition",
              startMs: 0,
              durationMs: 2500,
              assetId: "scene-a",
              ...(params ? { params } : {}),
            },
          ],
        },
      ],
      timeline: { entries: [{ sceneId: "scene-1", startMs: 0 }] },
    }),
    "film scene IR",
  );
}
