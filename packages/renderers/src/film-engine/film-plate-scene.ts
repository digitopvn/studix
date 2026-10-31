import { z } from "zod";
import { FILM_ENGINE_VERSION, FILM_SCENE_FORMAT, type FilmScenePackage } from "./film-scene-package.ts";

/** Particle weather presets of the ported engine. */
export const FILM_WEATHER_PRESETS = ["petal", "sakura", "snow", "ember", "leaf", "ash"] as const;

export const FilmPlateOptions = z.object({
  /** IR image asset the plate shows (a keyframe or a set frame). */
  imageAssetId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  durationMs: z.number().int().min(100).max(600_000),
  fps: z.number().int().min(1).max(120),
  width: z.number().int().min(16).max(3840),
  height: z.number().int().min(16).max(3840),
  /** Camera push over the shot: end zoom over start zoom (1 holds the frame). */
  push: z.number().min(1).max(1.5).default(1.06),
  /** Point the push moves towards, in frame fractions. */
  focus: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).default([0.5, 0.5]),
  /** Drifting particles over the plate, and their density (0-1). */
  weather: z.enum(FILM_WEATHER_PRESETS).optional(),
  density: z.number().min(0).max(1).default(0.35),
  lang: z.string().max(35).optional(),
});
export type FilmPlateOptions = z.input<typeof FilmPlateOptions>;

const num = (n: number) => Number(n.toFixed(4));

/**
 * A one-shot film scene that animates a still on the film engine: a cel with a slow camera push towards a
 * focus point and, optionally, particle weather. It is how a T0/T1 shot of a narrative pack moves without
 * an image-to-video call; the result is a regular versioned film-scene package.
 */
export function filmPlateScene(input: FilmPlateOptions): FilmScenePackage {
  const o = FilmPlateOptions.parse(input);
  const duration = o.durationMs / 1000;
  const weather = o.weather
    ? `weather: { preset: ${JSON.stringify(o.weather)}, count: 900, defaults: { swirl: 0.4 }, perShot: { plate: { density: ${num(o.density)}, size: 0.18 } } },`
    : "";
  const module = [
    "export const scene = {",
    "  sets: {},",
    "  cards: {},",
    `  cels: { plate: { zoom: [1.0, ${num(o.push)}], focus: [${num(o.focus[0])}, ${num(o.focus[1])}] } },`,
    `  ${weather}`,
    "};",
    "",
  ].join("\n");
  return {
    format: FILM_SCENE_FORMAT,
    engine: FILM_ENGINE_VERSION,
    ...(o.lang ? { lang: o.lang } : {}),
    edl: {
      fps: o.fps,
      duration,
      width: o.width,
      height: o.height,
      shots: [{ id: "plate", kind: "cel", start: 0, end: duration, img: `asset:${o.imageAssetId}` }],
    },
    module,
  };
}
