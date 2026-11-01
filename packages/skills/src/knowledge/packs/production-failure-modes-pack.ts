import type { KnowledgePack } from "../knowledge-pack-schema.ts";
import { animeCreatorSource } from "../knowledge-sources.ts";

const SKILL = animeCreatorSource("SKILL.md", "AC-38");

/**
 * The failure modes the source skill measured in earlier productions (each cost a retake, money or the
 * user's trust), turned into checks. Thresholds are the source's own numbers; ones the migration matrix
 * leaves to the owner carry `pendingReview`.
 */
export const productionFailureModesPack: KnowledgePack = {
  id: "production-failure-modes",
  version: "1.0.0",
  title: "Measured production failure modes",
  summary: "Failure modes measured in earlier productions, each with the check that catches it.",
  purpose:
    "Prevent the failures that cost retakes, money or trust in earlier runs of a generated-video pipeline: " +
    "framing and contact errors, generator defects, off-model drift, static or slow cuts, late or buried " +
    "sound, and delivery files that break loudness or size limits. Each failure mode is a check: hard when a " +
    "tool can measure it, evidence when a judge must look.",
  sources: [
    SKILL,
    animeCreatorSource("scripts/qa-prescan.py", "AC-27"),
    animeCreatorSource("scripts/audit-mix-buses.py", "AC-28"),
    animeCreatorSource("scripts/qa-gate-check.py", "AC-29"),
  ],
  phases: ["storyboard", "keyframe", "motion", "composition", "sound", "edit", "grade", "qa"],
  loadWhen: [
    "qa",
    "failure",
    "retake",
    "defect",
    "delivery",
    "loudness",
    "true peak",
    "hold",
    "static",
    "sfx",
    "mix",
    "image-to-video",
    "generated clip",
  ],
  useCases: [
    "Running the hard checks of a cut before any reviewer looks at it, so reviewers spend time on what a tool cannot see.",
    "Briefing a keyframe or clip prompt with the margins, contact points and cast clauses that prevent known generator defects.",
    "Deciding whether a defect needs a paid retake or a free repair first.",
  ],
  antiPatterns: [
    "Retrying a failing generation with a new seed and the same prompt.",
    "Trusting one AI reviewer's verdict without a strip or a measurement behind it.",
    "Fixing gains by ear before checking per-bus peaks.",
    "Re-encoding the delivery file after the limiter, so true peak overshoots.",
    "Picking a taste call (a stylised voice, a grade, an engine's look) alone instead of sending labelled variants.",
  ],
  sections: [
    {
      id: "prevention",
      title: "How each failure mode is prevented",
      entries: [
        {
          id: "cut-off-limbs",
          title: "Cut-off limbs and props",
          text:
            "Generators draw to the frame edge. Ask for an 8% margin, check every cut-out against the edge, and read " +
            "action beats as full-size strips, not small tiles.",
        },
        {
          id: "grip-contact",
          title: "Grip and contact logic",
          text:
            "Write handedness in the character file and the contact point in the brief; solve the geometry before " +
            "prompting the shot and its reverse.",
        },
        {
          id: "floating-figures",
          title: "Floating figures and flat staging",
          text:
            "Feet on the ground row of the set at their depth, a contact shadow, a perspective camera with height and " +
            "angle, and camera moves that show depth. Side-on sets read as an old 2D game.",
        },
        {
          id: "off-model-drift",
          title: "Off-model drift",
          text:
            "Model sheet first, at most three references, prompts compiled from the character bible. Retake with a " +
            "tighter brief and fewer references.",
        },
        {
          id: "generated-clip-defects",
          title: "Image-to-video defects",
          text:
            "Models ignore end poses they never see (give a last frame), hide cuts inside a clip (never let one shot " +
            "span a cut), duplicate characters and burn in text (negative suffix, cast clause, empty set text on " +
            "every prompt; free repairs before a paid retake) and misread non-Latin script in speech (check speech " +
            "with ASR). Some models need 4 s or more and snap to their end frame; others morph limbs after 4-5 s, " +
            "so keep their clips at 4 s or less and to one shot per scene unless the user routes an action-heavy " +
            "episode to them.",
          fields: { measuredLimbMorphAfterS: "4-5" },
        },
        {
          id: "staging-flips",
          title: "Staging that flips between boards",
          text:
            "Seats, sides, vehicle, direction of travel, scale and props changed between panels and drew most of 39 " +
            "storyboard notes on one episode. Write the scene's staging record before the first board and check every " +
            "panel against it.",
        },
        {
          id: "props-leak",
          title: "Props leaking from the bible",
          text:
            "A habit prop in a character's description appeared in nearly every shot. Scope props per shot; every " +
            "other shot says 'empty hands'.",
        },
        {
          id: "seed-retries",
          title: "Retrying a local model by seed",
          text:
            "A local model failed by prompt pattern (a hidden cut near frame 24, crash zoom, turning to camera, " +
            "talking in silent shots). The same failure on two seeds means: change the prompt or route the shot " +
            "to another engine.",
        },
        {
          id: "unused-frames",
          title: "Paying for unused frames",
          text: "Trim before upscaling, use the standard upscaler tier, and plan generated-frame utilisation above 50%.",
        },
        {
          id: "magenta-grade",
          title: "Magenta grade",
          text: "Blends run in planar RGB; test the grade on three frames before every full grade.",
        },
        {
          id: "overbright-fx",
          title: "Overbright FX",
          text:
            "Flashes that read as the sun, petals that read as snow: measure FX positions on the footage instead " +
            "of eyeballing them.",
        },
        {
          id: "weak-sound",
          title: "Weak or squashed sound",
          text:
            "Layer landings and hits (impact, debris tail, shake); check per-bus peaks before touching gains; " +
            "generate music in sections of 3000 ms or more, written from the beats, never a template's sample plan.",
        },
        {
          id: "late-sfx",
          title: "Late SFX",
          text:
            "A file placed by its start lands late (QA measured 0.55 s and 21 frames). Place by the transient at " +
            "the plate's own event frame, record the onset, and check the onsets.",
        },
        {
          id: "static-cut",
          title: "Static cut",
          text:
            "A mostly-still dialogue episode was rejected as static. Dialogue and emotion shots default to moving " +
            "inserts with the voice aligned onto the mouth, at least 60% motion by runtime, and no still held over " +
            "1.5 s.",
        },
        {
          id: "slow-action-rhythm",
          title: "Slow action rhythm",
          text:
            "An earlier episode cut its action at a mean 2.33 s (25 cuts a minute), held still for 0.65 of its " +
            "runtime and showed 2.3 impact frames a minute; eight action references cut at 0.8-1.3 s (44-77 a " +
            "minute), held 0-0.36 and showed 3-22. Measure every action sequence against a reference before the " +
            "edit locks.",
          fields: {
            measuredOurs: "mean shot 2.33 s, 25 cuts/min, hold share 0.65, 2.3 impact frames/min",
            measuredReferences:
              "mean shot 0.8-1.3 s, 44-77 cuts/min, hold share 0-0.36, 3-22 impact frames/min",
          },
        },
        {
          id: "qa-model-trust",
          title: "Trusting a QA model",
          text:
            "A video QA model samples about one frame a second and is a weak ear; verify every claim with a strip " +
            "or a measurement and record the verdict. A cut goes to two independent reviewers scoring a rubric of " +
            "the user's verbatim notes and intent notes after the tool prescan, and ships when both pass.",
        },
        {
          id: "layer-split-jitter",
          title: "Layer-split jitter",
          text:
            "An overlay that holds still while its footage moves reads as a cut-out shaking. Use flat pushes on " +
            "single paintings; make overlays ride the camera or the tracked plate.",
        },
        {
          id: "buried-ambience",
          title: "Buried or generic ambience",
          text:
            "Beds 10-15 dB under the music failed the 'you can hear where you are' note. Gate the mix buses, then " +
            "send the beds stem to the user's ear: the numbers alone passed a scene the user rejected. When " +
            "generated beds sound generic, switch to real recordings in one shared acoustic space.",
        },
        {
          id: "delivery-overshoot",
          title: "Delivery overshoot",
          text:
            "Lossy re-encodes broke the -1.5 dBTP ceiling (up to +0.4 dBTP) and a 30.1 MiB file was refused by " +
            "chat. Encode from the PCM mix behind the oversampled limiter, size the phone copy to 28 MiB, and " +
            "measure every file.",
          fields: { phoneCopyTargetMiB: "28" },
        },
        {
          id: "stacked-fade",
          title: "Stacked fade",
          text: "A fade-from-black cue on top of the composition's own fade-in held frame 0 black.",
        },
        {
          id: "taste-call",
          title: "Picking a taste call alone",
          text:
            "A stylised voice, a grade or an engine's look is the user's pick. Make labelled variants, send them, " +
            "wait, and record the pick.",
        },
        {
          id: "sfx-left-by-retake",
          title: "SFX left behind by a retake",
          text:
            "One shot's cues stayed timed for its old take (2.25 s off) and QA heard a stray rustle. After any " +
            "retake or trim, retime the events anchored to that shot by the in-point delta, then re-check onsets.",
        },
      ],
    },
    {
      id: "engine-owned",
      title: "Failure modes the engine owns",
      entries: [
        {
          id: "price-traps",
          title: "Price traps",
          text:
            "Catalog prices were wrong by up to 18x. One probe job per unmeasured model, then the ledger, then the " +
            "batch; the media provider adapter and the budget fence enforce this.",
        },
        {
          id: "idle-pipeline",
          title: "Idle pipeline between sessions",
          text:
            "Worker sessions finished and nothing started for hours. Durable jobs on the queue continue without a " +
            "session; watch job state, not chat events.",
        },
        {
          id: "parallel-writers",
          title: "Parallel writers and lost state",
          text:
            "Two jobs writing one shared file corrupted it, and state kept only in a session was lost on compaction. " +
            "One writer per record through fenced checkpoints in the database.",
        },
        {
          id: "lock-by-guess",
          title: "Deleting a lock by guess",
          text: "A stale lock was deleted by age. Leases are reclaimed only when the owner's lease has expired.",
        },
        {
          id: "stale-bundle",
          title: "Stale bundle, dead render",
          text:
            "Rendering an unbundled composition and long scenes exhausting memory killed renders. The renderer " +
            "adapter checks freshness and renders one scene at a time.",
        },
        {
          id: "hard-wired-engines",
          title: "Hard-wired engines",
          text:
            "Not every user has the same local model, GPU or API. Engines are chosen by role through adapters; never " +
            "write a machine path into a tool.",
        },
        {
          id: "quota-blow-out",
          title: "Quota blow-out",
          text:
            "Nineteen parallel agents hit the session limit mid-QA with no handoff. Cap parallel agents at about four " +
            "and write the handoff early.",
        },
      ],
    },
  ],
  checks: [
    {
      id: "production-failure-modes.cutout-edge-margin",
      kind: "hard",
      level: "asset",
      measure: "Cut-outs with opaque pixels inside the frame-edge margin.",
      metric: { id: "cutout-edge-margin-violations", unit: "count" },
      threshold: { op: "==", value: 0 },
      params: { marginRatio: 0.08 },
    },
    {
      id: "production-failure-modes.reference-count",
      kind: "hard",
      level: "asset",
      measure: "Reference images attached to one character generation prompt.",
      metric: { id: "generation-reference-count", unit: "count" },
      threshold: { op: "<=", value: 3 },
    },
    {
      id: "production-failure-modes.no-cut-in-clip",
      kind: "hard",
      level: "shot",
      measure: "Hard cuts detected (frame-difference spikes) inside the used range of a generated clip.",
      metric: { id: "hidden-cuts-in-used-range", unit: "count" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "production-failure-modes.frame-utilization",
      kind: "hard",
      level: "job",
      measure: "Share of generated video frames that end up in the cut.",
      metric: { id: "generated-frame-utilization", unit: "ratio" },
      threshold: { op: ">", value: 0.5 },
    },
    {
      id: "production-failure-modes.grade-test-frames",
      kind: "hard",
      level: "video",
      measure: "Frames graded in a test pass before a full grade runs.",
      metric: { id: "grade-test-frames", unit: "count" },
      threshold: { op: ">=", value: 3 },
    },
    {
      id: "production-failure-modes.music-section-length",
      kind: "hard",
      level: "video",
      measure: "Length of the shortest generated music section.",
      metric: { id: "music-section-min-ms", unit: "ms" },
      threshold: { op: ">=", value: 3000 },
    },
    {
      id: "production-failure-modes.sfx-onset",
      kind: "hard",
      level: "scene",
      measure:
        "Sound events whose recorded onset disagrees with the measured transient by more than the tolerance, or " +
        "that carry no onset while their file starts with silence.",
      metric: { id: "sfx-onset-mismatches", unit: "count" },
      threshold: { op: "==", value: 0 },
      params: { toleranceFrames: 1 },
    },
    {
      id: "production-failure-modes.sfx-follow-retake",
      kind: "hard",
      level: "scene",
      measure:
        "Sound events anchored to a retaken or trimmed shot that were not retimed by its in-point delta.",
      metric: { id: "stale-anchored-sfx-events", unit: "count" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "production-failure-modes.motion-share",
      kind: "hard",
      level: "video",
      measure:
        "Share of a dialogue or emotion video's runtime that is moving picture rather than held stills.",
      metric: { id: "motion-runtime-share", unit: "ratio" },
      threshold: { op: ">=", value: 0.6 },
    },
    {
      id: "production-failure-modes.still-hold",
      kind: "hard",
      level: "shot",
      measure: "Longest span of near-still picture.",
      metric: { id: "still-hold-max-s", unit: "seconds" },
      threshold: { op: "<=", value: 1.5 },
    },
    {
      id: "production-failure-modes.leading-black",
      kind: "hard",
      level: "video",
      measure: "Length of the black run (mean luma under the floor) that starts at frame 0.",
      metric: { id: "leading-black-s", unit: "seconds" },
      threshold: { op: "<=", value: 0.5 },
      params: { lumaFloor: 16 },
    },
    {
      id: "production-failure-modes.bed-masking",
      kind: "hard",
      level: "scene",
      measure:
        "Share of the scene's analysis windows where the ambience bed is audible over the rest of the mix.",
      metric: { id: "ambience-mask-share", unit: "ratio" },
      threshold: { op: ">=", value: 0.6 },
    },
    {
      id: "production-failure-modes.beds-under-music",
      kind: "hard",
      level: "scene",
      measure: "Ambience bed level minus music level.",
      metric: { id: "beds-minus-music-db", unit: "db" },
      threshold: { op: ">=", value: -6 },
    },
    {
      id: "production-failure-modes.voice-over-beds",
      kind: "hard",
      level: "scene",
      measure: "Voice level minus ambience bed level.",
      metric: { id: "voice-minus-beds-db", unit: "db" },
      threshold: { op: ">=", value: 6 },
    },
    {
      id: "production-failure-modes.bed-present",
      kind: "hard",
      level: "scene",
      measure: "Level of the ambience bed (a scene with no bed fails).",
      metric: { id: "bed-level-dbfs", unit: "db" },
      threshold: { op: ">", value: -70 },
    },
    {
      id: "production-failure-modes.delivery-loudness",
      kind: "hard",
      level: "asset",
      measure: "Integrated loudness of every delivered file.",
      metric: { id: "integrated-loudness-lufs", unit: "lufs" },
      threshold: { op: "between", min: -15, max: -13 },
    },
    {
      id: "production-failure-modes.delivery-true-peak",
      kind: "hard",
      level: "asset",
      measure: "True peak of every delivered file, measured after encoding.",
      metric: { id: "true-peak-dbtp", unit: "dbtp" },
      threshold: { op: "<=", value: -1.5 },
    },
    {
      id: "production-failure-modes.chat-delivery-size",
      kind: "hard",
      level: "asset",
      measure: "Size of a file sent to chat.",
      metric: { id: "delivery-file-mib", unit: "mib" },
      threshold: { op: "<", value: 30 },
    },
    {
      id: "production-failure-modes.master-frame-count",
      kind: "hard",
      level: "video",
      measure: "Frame count of the master minus the frame count of the edit decision list.",
      metric: { id: "master-frame-count-delta", unit: "frames" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "production-failure-modes.lipsync-offset",
      kind: "hard",
      level: "shot",
      measure: "Offset between the aligned voice take and the mouth movement of the clip.",
      metric: { id: "lipsync-offset-frames", unit: "frames" },
      threshold: { op: "<=", value: 3 },
      pendingReview: "Migration matrix AC-11: the 3-frame lipsync gate needs the owner's approval.",
    },
    {
      id: "production-failure-modes.contact-and-staging",
      kind: "evidence",
      level: "shot",
      measure:
        "The reviewer checks grip handedness, contact points, feet on the ground row with a contact shadow, and a " +
        "camera that shows depth.",
      judges: ["ai", "human"],
      evidence: ["frame-strip"],
      pass: "No wrong hand, floating figure or flat side-on staging.",
    },
    {
      id: "production-failure-modes.on-model",
      kind: "evidence",
      level: "shot",
      measure: "The reviewer compares keyframes against the character's model sheet.",
      judges: ["ai", "human"],
      evidence: ["contact-sheet"],
      pass: "Silhouette, palette and costume match the sheet.",
    },
    {
      id: "production-failure-modes.generated-clip-defects",
      kind: "evidence",
      level: "shot",
      measure:
        "The reviewer looks for duplicated characters, burned-in text, morphing limbs and an ignored end pose, and " +
        "checks speech against an ASR transcript.",
      judges: ["ai", "human"],
      evidence: ["frame-strip", "measurement"],
      pass: "None found, or each has a recorded free repair or retake.",
    },
    {
      id: "production-failure-modes.staging-record",
      kind: "evidence",
      level: "scene",
      measure:
        "The reviewer checks every board against the scene's staging record: seats, sides, direction of travel, " +
        "scale and props, and that props are scoped per shot.",
      judges: ["ai", "human"],
      evidence: ["contact-sheet", "document"],
      pass: "No panel contradicts the staging record.",
    },
    {
      id: "production-failure-modes.fx-placement",
      kind: "evidence",
      level: "shot",
      measure:
        "The reviewer checks FX against measured positions on the footage and their brightness in context.",
      judges: ["ai", "human"],
      evidence: ["frame-strip", "measurement"],
      pass: "No flash reads as the sun and no particle reads as something else; overlays ride their footage.",
    },
    {
      id: "production-failure-modes.action-rhythm",
      kind: "evidence",
      level: "scene",
      measure:
        "Cut rhythm, hold share and impact frames per minute of each action sequence, measured against a " +
        "reference cut before the edit locks.",
      judges: ["ai", "human"],
      evidence: ["measurement", "clip"],
      pass: "The sequence sits within the reference band, or the deviation is recorded and approved.",
    },
    {
      id: "production-failure-modes.ambience-by-ear",
      kind: "evidence",
      level: "scene",
      measure: "The user listens to the beds stem of the scene.",
      judges: ["human"],
      evidence: ["audio"],
      pass: "The user can hear where the scene takes place.",
    },
    {
      id: "production-failure-modes.two-reviewers",
      kind: "evidence",
      level: "video",
      measure:
        "Two independent reviewers score a rubric of the user's verbatim notes and intent notes after the tool " +
        "prescan; every claim is backed by a strip or a measurement.",
      judges: ["ai", "human"],
      evidence: ["frame-strip", "measurement", "document"],
      pass:
        "Both reviewers pass every rubric item (the source used a minimum score of 7; matrix AV-11 leaves the " +
        "number to the owner). An AI review alone never approves the cut.",
    },
    {
      id: "production-failure-modes.taste-call",
      kind: "evidence",
      level: "video",
      measure: "Labelled variants of a taste call (stylised voice, grade, engine look) are sent to the user.",
      judges: ["human"],
      evidence: ["contact-sheet", "audio"],
      pass: "The user's pick is recorded before the choice is used.",
    },
  ],
};
