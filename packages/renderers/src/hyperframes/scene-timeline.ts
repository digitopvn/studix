// Adapted from motion-mcp packages/hyperframes-adapter/src/motion.ts @ 408ceccd (MIT, Copyright (c) 2026 Digitop).
import type { MotionPreset, Scene, Shot, TransitionKind } from "@studix/video-ir";
import { num, scriptJson, seconds } from "./html-utils.ts";

type Vars = Record<string, string | number | boolean>;

/**
 * Emits GSAP statements for one scene timeline. Rules that keep HyperFrames' seek-based capture exact:
 * - every tween is placed at an absolute scene-local position, so seeking to any frame is deterministic;
 * - the first tween on a target keeps GSAP's default immediateRender (start state applied at t=0); later
 *   tweens on that target use immediateRender:false so their start state never leaks back to t=0;
 * - only opacity, transforms and clip-path animate (no layout properties); no repeats or callbacks.
 */
export class TimelineWriter {
  readonly lines: string[] = [];
  private readonly started = new Set<string>();

  fromTo(target: string, from: Vars, to: Vars, positionSec: number): void {
    const toVars: Vars = { ...to };
    if (this.started.has(target)) toVars.immediateRender = false;
    this.started.add(target);
    this.lines.push(
      `tl.fromTo(${scriptJson(target)}, ${scriptJson(from)}, ${scriptJson(toVars)}, ${num(positionSec)});`,
    );
  }

  set(target: string, vars: Vars, positionSec: number): void {
    this.started.add(target);
    this.lines.push(`tl.set(${scriptJson(target)}, ${scriptJson(vars)}, ${num(positionSec)});`);
  }
}

const DEFAULT_ANIMATION_MS = 400;
const ENTER_EASE = "power3.out";
const EXIT_EASE = "power2.in";

/** Start offsets per preset; `travel` is a fraction of the short frame edge. */
function presetOffset(preset: MotionPreset, travel: number): Vars {
  switch (preset) {
    case "slide-up":
      return { y: travel };
    case "slide-down":
      return { y: -travel };
    case "slide-left":
      return { x: travel };
    case "slide-right":
      return { x: -travel };
    case "scale":
      return { scale: 0.85 };
    case "pop":
      return { scale: 0.6 };
    default:
      return {};
  }
}

function settled(offset: Vars): Vars {
  return Object.fromEntries(Object.keys(offset).map((k) => [k, k === "scale" ? 1 : 0]));
}

/** Exit keeps moving in the entrance direction (a slide-up leaves upwards). */
function exitOffset(preset: MotionPreset, travel: number): Vars {
  const enter = presetOffset(preset, travel);
  return Object.fromEntries(
    Object.entries(enter).map(([k, v]) => [k, k === "scale" ? 2 - Number(v) : -Number(v)]),
  );
}

/**
 * Shot visibility and motion. Shots start hidden (CSS opacity 0), appear at startMs with their enter
 * preset, and disappear at their end with the exit preset or a hard cut when they end before the scene.
 */
export function writeShotMotion(
  w: TimelineWriter,
  selector: string,
  shot: Shot,
  sceneDurationMs: number,
  frame: { width: number; height: number },
): void {
  const travel = Math.round(0.06 * Math.min(frame.width, frame.height));
  const enter = shot.animation?.enter ?? "fade";
  const exit = shot.animation?.exit ?? "none";
  // Enter and exit share the shot, so each gets at most half of it.
  const animMs = Math.min(
    shot.animation?.durationMs ?? DEFAULT_ANIMATION_MS,
    Math.floor(shot.durationMs / 2),
  );
  const start = seconds(shot.startMs);
  const end = shot.startMs + shot.durationMs;
  const d = seconds(animMs);

  if (enter === "none" || animMs === 0) {
    w.set(selector, { opacity: 1 }, start);
  } else {
    const off = presetOffset(enter, travel);
    const ease = enter === "pop" ? "back.out(1.7)" : ENTER_EASE;
    w.fromTo(selector, { opacity: 0, ...off }, { opacity: 1, ...settled(off), duration: d, ease }, start);
  }

  if (exit !== "none" && animMs > 0) {
    const off = presetOffset(exit, travel);
    w.fromTo(
      selector,
      { opacity: 1, ...settled(off) },
      { opacity: 0, ...exitOffset(exit, travel), duration: d, ease: EXIT_EASE },
      seconds(end - animMs),
    );
  } else if (end < sceneDurationMs) {
    w.set(selector, { opacity: 0 }, seconds(end));
  }
}

export interface ResolvedTransition {
  kind: TransitionKind;
  durationMs: number;
}

/**
 * A scene's transitionOut is played as two halves: the outgoing half at the end of this scene and the
 * incoming half at the start of the next, dipping through the root background. Scenes never overlap on
 * the HyperFrames timeline, so this keeps the total duration exact. Each half is capped at 40% of its scene.
 */
export function sceneTransitions(
  scenes: readonly Scene[],
  index: number,
): { in?: ResolvedTransition; out?: ResolvedTransition } {
  const scene = scenes[index]!;
  const prev = index > 0 ? scenes[index - 1] : undefined;
  const cap = Math.floor(scene.durationMs * 0.4);
  const half = (t: Scene["transitionOut"]): ResolvedTransition | undefined =>
    t && t.kind !== "cut" && t.kind !== "match-cut" && t.durationMs > 0
      ? { kind: t.kind, durationMs: Math.min(cap, Math.round(t.durationMs / 2)) }
      : undefined;
  const isLast = index === scenes.length - 1;
  return { in: half(prev?.transitionOut), out: isLast ? undefined : half(scene.transitionOut) };
}

export function writeTransition(
  w: TimelineWriter,
  stageSelector: string,
  phase: "in" | "out",
  transition: ResolvedTransition | undefined,
  sceneDurationMs: number,
): void {
  if (!transition || transition.durationMs <= 0) return;
  const d = seconds(transition.durationMs);
  const pos = phase === "in" ? 0 : seconds(sceneDurationMs - transition.durationMs);
  const tween = (from: Vars, to: Vars, ease: string) =>
    w.fromTo(stageSelector, from, { ...to, duration: d, ease }, pos);
  const inbound = phase === "in";
  switch (transition.kind) {
    case "fade":
      if (inbound) tween({ opacity: 0 }, { opacity: 1 }, "power2.out");
      else tween({ opacity: 1 }, { opacity: 0 }, "power2.in");
      return;
    case "slide":
      if (inbound) tween({ xPercent: 100 }, { xPercent: 0 }, "power3.out");
      else tween({ xPercent: 0 }, { xPercent: -100 }, "power3.in");
      return;
    case "wipe":
      if (inbound)
        tween({ clipPath: "inset(0% 100% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)" }, "power2.inOut");
      else tween({ clipPath: "inset(0% 0% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 100%)" }, "power2.inOut");
      return;
    case "zoom":
      if (inbound) tween({ opacity: 0, scale: 0.86 }, { opacity: 1, scale: 1 }, "power2.out");
      else tween({ opacity: 1, scale: 1 }, { opacity: 0, scale: 1.18 }, "power2.in");
      return;
    case "iris":
      if (inbound)
        tween({ clipPath: "circle(0% at 50% 50%)" }, { clipPath: "circle(75% at 50% 50%)" }, "power2.out");
      else tween({ clipPath: "circle(75% at 50% 50%)" }, { clipPath: "circle(0% at 50% 50%)" }, "power2.in");
      return;
    case "whip":
      // Faster and more violent than a slide: a short lateral throw with a lean, fading at the far end.
      if (inbound)
        tween({ xPercent: 40, skewX: -10, opacity: 0 }, { xPercent: 0, skewX: 0, opacity: 1 }, "expo.out");
      else tween({ xPercent: 0, skewX: 0, opacity: 1 }, { xPercent: -40, skewX: 10, opacity: 0 }, "expo.in");
      return;
    case "cut":
    case "match-cut":
      return;
  }
}
