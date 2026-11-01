import type { KnowledgePack } from "../knowledge-pack-schema.ts";
import { agentkitSource } from "../knowledge-sources.ts";

const RENDERER = "kits/core/skills/ak-remotion";
const rule = (name: string) => agentkitSource(`${RENDERER}/rules/${name}.md`, "RM-01");

export const compositionTimingPack: KnowledgePack = {
  id: "composition-timing",
  version: "1.0.0",
  title: "Composition, sequencing and frame timing",
  summary:
    "Structure of a renderable composition, sequencing and trimming in frames, interpolation and springs, transitions, deterministic media and font loading.",
  purpose:
    "Make a code-based render reproducible and its timing exact: every composition declares its size, fps and " +
    "length in frames; every animated value is a function of the current frame; scenes are placed, trimmed and " +
    "overlapped by frame arithmetic; and every image, clip, sound and font is a pinned local asset that is fully " +
    "loaded before the frame that shows it is captured. Media is never fetched from a remote URL at render time.",
  sources: [
    agentkitSource(`${RENDERER}/SKILL.md`, "RM-01"),
    rule("compositions"),
    rule("calculate-metadata"),
    rule("sequencing"),
    rule("timing"),
    rule("animations"),
    rule("trimming"),
    rule("transitions"),
    rule("assets"),
    rule("images"),
    rule("videos"),
    rule("audio"),
    rule("fonts"),
  ],
  phases: ["composition", "motion", "edit", "sound", "qa"],
  loadWhen: [
    "composition",
    "sequence",
    "timeline",
    "fps",
    "duration",
    "frame",
    "interpolate",
    "easing",
    "spring",
    "trim",
    "transition",
    "overlap",
    "asset loading",
    "font loading",
    "render",
  ],
  useCases: [
    "Laying out a cut as back-to-back scenes with overlapping transitions and computing the exact total frame count.",
    "Delaying a title, trimming the head of an animation and limiting how long it stays on screen, all in frames.",
    "Choosing between a clamped eased interpolation and a damped spring for an entrance, and combining an in and an out spring.",
    "Deriving composition duration and size from pinned media before render, instead of hard-coding a placeholder.",
    "Placing music and effects with per-frame volume curves, mute windows and trims that line up with picture.",
    "Checking a final render against the declared width, height, fps and frame count before sign-off.",
  ],
  antiPatterns: [
    "Animating with time-based style transitions, keyframe animation classes or timers: they follow the wall clock, not the frame, and do not render correctly.",
    "Hard-coding frame counts that assume one fps instead of writing durations in seconds times fps.",
    "Unclamped interpolation that keeps moving past the end of its frame window.",
    "Summing scene lengths for the total when transitions overlap them, so the composition ends late with empty frames.",
    "Referencing media by a remote URL, so a render depends on the network and may differ or fail.",
    "Using a plain image element or a background image for picture content, which can capture blank or flickering frames before it loads.",
    "Rendering text before its font has loaded, so the first frames use a fallback face.",
    "Treating an interactive preview as proof that the render is correct.",
  ],
  sections: [
    {
      id: "composition-structure",
      title: "Composition structure",
      entries: [
        {
          id: "composition-definition",
          title: "A composition declares its frame contract",
          text:
            "A renderable composition names an id, the component that draws it, width and height in pixels, frames per " +
            "second, and duration in frames. Everything downstream (sequences, springs, media trims) is expressed " +
            "against that fps and frame range.",
          fields: { required: "id, component, width, height, fps, durationInFrames" },
        },
        {
          id: "still",
          title: "Stills are single-frame compositions",
          text: "A still (a thumbnail, a poster frame) declares only id, component, width and height; it has no fps or duration.",
        },
        {
          id: "serialisable-props",
          title: "Typed, serialisable input props",
          text:
            "Default input props must be serialisable data so a render can be reproduced from them. Declare their type " +
            "and check the defaults against it at the definition site.",
        },
        {
          id: "derived-metadata",
          title: "Derive metadata before render",
          text:
            "Duration, size, fps and props may be computed once before rendering from the input: read the length and " +
            "dimensions of pinned media and set `durationInFrames = ceil(seconds * fps)`, sum several clips for a " +
            "sequence of them, or match the frame size to a source clip with a fallback. Returned values override the " +
            "declared ones. Any inputs it reads must themselves be pinned assets, not remote fetches.",
        },
      ],
    },
    {
      id: "sequencing",
      title: "Sequencing",
      entries: [
        {
          id: "sequence-offset",
          title: "Place content with a start frame and duration",
          text:
            "A sequence shifts its children to start at a given frame and may limit how long they stay mounted. " +
            "Write both as seconds times fps. By default a sequence fills the frame; opt out when children position themselves.",
        },
        {
          id: "local-time",
          title: "Children see local time",
          text:
            "Inside a sequence the current frame restarts at 0. A child placed at frame 60 for 30 frames sees 0..29, so " +
            "components are written once and reused anywhere on the timeline.",
        },
        {
          id: "premount",
          title: "Load ahead of the start",
          text:
            "Mount a sequence's content some frames before it becomes visible so its assets and fonts are ready when it " +
            "appears. Premount every sequence.",
        },
        {
          id: "series",
          title: "Series: back-to-back scenes",
          text:
            "A series plays its items one after another without gaps; each item only declares its own duration. A " +
            "negative offset on an item starts it that many frames before the previous one ends, for overlaps.",
        },
        {
          id: "nested-sequences",
          title: "Nested sequences",
          text:
            "Sequences nest: an outer sequence sets a scene's window, inner sequences stagger its elements relative " +
            "to the scene's own start.",
        },
      ],
    },
    {
      id: "frame-timing",
      title: "Frame-driven timing and interpolation",
      entries: [
        {
          id: "frame-driven",
          title: "Every animation is a function of the frame",
          text:
            "Read the current frame and compute each animated value from it. Author durations in seconds and multiply " +
            "by fps. Wall-clock animation (time-based style transitions, animation classes, timers) is forbidden: the " +
            "renderer captures frames out of real time, so it will not render correctly.",
        },
        {
          id: "interpolate-and-clamp",
          title: "Map a frame range to a value range, and clamp",
          text:
            "Linear interpolation maps an input frame range onto an output range. It extrapolates beyond the range by " +
            "default, so clamp both ends unless continued motion is intended.",
        },
        {
          id: "easing",
          title: "Easing: convexity times curve",
          text:
            "An easing combines a convexity (in: slow start, out: slow end, in-out: both) with a curve. From most linear " +
            "to most curved: quad, sine, exponential, circular. A cubic bezier gives a custom curve. The default is linear.",
          fields: { convexities: "in, out, in-out", curves: "quad, sin, exp, circle (least to most curved)" },
        },
        {
          id: "springs",
          title: "Springs",
          text:
            "A spring animates 0 to 1 with mass-spring-damper physics and reads more natural than an eased curve. Low " +
            "damping overshoots and settles; high damping settles without bounce. The reference parameterisation and " +
            "presets below are relative to that model.",
          fields: {
            reference: "mass 1, damping 10, stiffness 100: slight bounce before settling",
            smooth: "damping 200: no bounce, subtle reveals",
            snappy: "damping 20, stiffness 200: minimal bounce, interface elements",
            bouncy: "damping 8: playful entrance",
            heavy: "damping 15, stiffness 80, mass 2: slow, small bounce",
          },
        },
        {
          id: "spring-duration-and-delay",
          title: "Spring delay and duration",
          text:
            "A spring starts at once unless delayed by a number of frames. Its natural length depends on its physics " +
            "and on fps; stretch it to an exact frame count when it must fit a window.",
        },
        {
          id: "spring-composition",
          title: "Combining springs",
          text:
            "Spring output is a plain number: map 0..1 onto any range (degrees, pixels) with interpolation, or subtract " +
            "an out-spring delayed to the last second from an in-spring to animate in and out with one value.",
        },
      ],
    },
    {
      id: "trimming",
      title: "Trimming",
      entries: [
        {
          id: "trim-start",
          title: "Trim the head",
          text:
            "Starting a sequence at a negative frame shifts time back, so the content appears partway through its own " +
            "animation: with 15 frames trimmed, its local frame begins at 15.",
        },
        {
          id: "trim-end",
          title: "Trim the tail",
          text: "Limiting a sequence's duration unmounts the content after that many frames.",
        },
        {
          id: "trim-and-delay",
          title: "Trim and delay together",
          text: "Nest the two: the inner sequence trims the head, the outer one sets where the trimmed result starts on the timeline.",
        },
        {
          id: "media-trim",
          title: "Trim media in frames",
          text:
            "Clips and sounds take a trim-before and trim-after point in frames (seconds times fps). Only that portion " +
            "plays, still starting at the containing sequence's start; wrap the media in a sequence to delay it.",
        },
      ],
    },
    {
      id: "transitions",
      title: "Transitions",
      entries: [
        {
          id: "transition-overlap",
          title: "Transitions overlap scenes",
          text:
            "During a transition both adjacent scenes play at once, so each transition shortens the total. The " +
            "composition length is the sum of scene durations minus the sum of transition durations.",
          fields: {
            formula: "total = sum(scene frames) - sum(transition frames)",
            example: "60 + 60 - 15 = 105 frames",
          },
        },
        {
          id: "presentations",
          title: "Presentation types",
          text:
            "Common full-frame transitions: fade, slide (from left, right, top or bottom), wipe, flip and clock wipe. " +
            "The presentation decides how the two scenes are drawn; the timing decides its length and curve.",
        },
        {
          id: "transition-timing",
          title: "Linear or spring timing",
          text:
            "Linear timing runs at constant speed for a fixed frame count. Spring timing is more organic; without an " +
            "explicit frame count its length depends on fps, so compute it from the timing at the composition's fps " +
            "before summing the total.",
        },
      ],
    },
    {
      id: "media-loading",
      title: "Deterministic media loading",
      entries: [
        {
          id: "pinned-assets",
          title: "Pinned local assets only",
          text:
            "Every image, clip, sound and font is a pinned asset in the project's asset store, referenced through the " +
            "renderer's asset resolver (which also encodes special characters such as `#`, `?`, `&` in file names). " +
            "Never fetch media from a remote URL at render time.",
        },
        {
          id: "blocking-media-primitives",
          title: "Use media primitives that block until loaded",
          text:
            "Draw images, clips and sound with the renderer's own media primitives, which hold the frame until the " +
            "asset is decoded. A plain image element, a framework image component or a background image can be " +
            "captured before it loads, producing blank or flickering frames.",
        },
        {
          id: "frame-indexed-assets",
          title: "Frame-indexed and prop-selected assets",
          text:
            "Asset paths may be built from the current frame (an image sequence, one file per frame) or from props and " +
            "state (per-subject images, themed icons), as long as each resolved path is a pinned asset.",
        },
        {
          id: "measure-before-sizing",
          title: "Read dimensions before sizing",
          text:
            "Read an image's or clip's width and height before laying it out or sizing the composition to it, rather " +
            "than assuming an aspect ratio.",
        },
        {
          id: "media-volume",
          title: "Volume and muting",
          text:
            "Volume is a static 0..1 value or a per-frame curve; the curve's frame starts at 0 when the media starts, not " +
            "at the composition's frame 0. Muting can be switched per frame for mute windows. Several sound tracks layer " +
            "by adding more of them.",
        },
        {
          id: "media-rate-loop-pitch",
          title: "Playback rate, looping and pitch",
          text:
            "Playback rate speeds up or slows down media; reverse playback is not available. A looped item either " +
            "restarts its volume-curve frame each loop or keeps counting across loops (for a fade over several loops). " +
            "Pitch can be shifted independently of speed, but only in the final render, not in interactive preview.",
          fields: { pitchRange: "0.01 to 2" },
        },
      ],
    },
    {
      id: "fonts",
      title: "Font loading before render",
      entries: [
        {
          id: "font-blocks-render",
          title: "Block rendering until the font is ready",
          text:
            "Load every face a composition uses, and wait for it, before any frame with text is captured. Load at module " +
            "top level or in a file imported early, so components never render with a fallback face.",
        },
        {
          id: "font-subsets",
          title: "Load only needed weights and subsets",
          text: "Request only the weights, styles and character subsets the text uses, to keep load time and size down.",
        },
        {
          id: "local-font-families",
          title: "Register local weights under one family",
          text:
            "For local font files, register each weight and style under the same family name and wait for all of them " +
            "together before rendering.",
        },
      ],
    },
    {
      id: "render-verification",
      title: "Render verification",
      entries: [
        {
          id: "render-is-the-proof",
          title: "Inspect the final render, not the preview",
          text:
            "Verify the composition id and props, width and height, fps, duration and frame range, asset loading and " +
            "audio synchronisation on the rendered file itself. A preview is not render proof. Report any dimension " +
            "that was not verified.",
        },
      ],
    },
  ],
  checks: [
    {
      id: "composition-timing.no-remote-media",
      kind: "hard",
      level: "video",
      measure:
        "Image, clip, sound, font or data references in the composition and its metadata step that resolve to a remote URL.",
      metric: { id: "remote-media-refs", unit: "count" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "composition-timing.frame-driven-animation",
      kind: "hard",
      level: "video",
      measure:
        "Animated properties driven by the wall clock (time-based style transitions, animation classes, timers) " +
        "instead of the current frame.",
      metric: { id: "wall-clock-animations", unit: "count" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "composition-timing.duration-arithmetic",
      kind: "hard",
      level: "video",
      measure:
        "Absolute difference between the declared duration and the sum of scene durations minus the sum of " +
        "transition durations at the composition's fps.",
      metric: { id: "composition-duration-error", unit: "frames" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "composition-timing.render-matches-declared",
      kind: "hard",
      level: "video",
      measure:
        "Fields of the final rendered file (width, height, fps, frame count) that differ from the composition's declaration.",
      metric: { id: "render-metadata-mismatches", unit: "count" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "composition-timing.media-loaded-before-capture",
      kind: "hard",
      level: "video",
      measure: "Frames captured while an image, clip or sound they show was not yet loaded.",
      metric: { id: "frames-before-media-ready", unit: "frames" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "composition-timing.fonts-loaded-before-capture",
      kind: "hard",
      level: "video",
      measure:
        "Font faces used by the composition that were not loaded before the first frame showing them was captured.",
      metric: { id: "fonts-not-ready", unit: "count" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "composition-timing.serialisable-props",
      kind: "hard",
      level: "video",
      measure: "Input prop values of the composition that are not serialisable data.",
      metric: { id: "non-serialisable-props", unit: "count" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "composition-timing.interpolation-in-range",
      kind: "evidence",
      level: "shot",
      measure: "Frames at the start and end of each animated element's window.",
      judges: ["ai", "human"],
      evidence: ["frame-strip"],
      pass: "No animated value runs past its intended range outside its window, except an intended spring overshoot.",
    },
    {
      id: "composition-timing.audio-sync",
      kind: "evidence",
      level: "video",
      measure:
        "The final render played with its sound: music, effects and voice against the picture events they belong to.",
      judges: ["ai", "human"],
      evidence: ["clip", "audio"],
      pass: "Each sound starts, ends and changes volume on its intended frames, with no drift over the length of the render.",
    },
    {
      id: "composition-timing.final-render-inspected",
      kind: "evidence",
      level: "video",
      measure:
        "Where the verification evidence came from: the final rendered file or an interactive preview.",
      judges: ["human"],
      evidence: ["clip", "measurement"],
      pass: "All verification came from the final rendered file, and every dimension that was not verified is reported.",
    },
  ],
};
