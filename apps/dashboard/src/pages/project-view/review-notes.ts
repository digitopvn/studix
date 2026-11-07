import type { FeedbackRequest, FramePoint, ReviewAnnotation, ReviewShot } from "../../api-client.ts";

export type Tool = "box" | "pin" | "pen" | "arrow";
export type Intent = NonNullable<ReviewAnnotation["intent"]>;
export type Priority = NonNullable<ReviewAnnotation["priority"]>;

/** A note being written on a paused frame, before it is sent. */
export interface DraftNote {
  id: string;
  frameMs: number;
  endMs?: number;
  shotId?: string;
  text: string;
  intent: Intent;
  priority: Priority;
  region?: FramePoint & { w: number; h: number };
  pins: Array<FramePoint & { label?: string }>;
  strokes: Array<{ tool: "pen" | "arrow"; points: FramePoint[] }>;
  snapshot?: string;
  references: Array<{ url: string; note?: string }>;
}

export function blankNote(frameMs: number, shotId?: string): DraftNote {
  return {
    id: crypto.randomUUID(),
    frameMs,
    ...(shotId ? { shotId } : {}),
    text: "",
    intent: "change",
    priority: "should",
    pins: [],
    strokes: [],
    references: [],
  };
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function shotAt(shots: ReviewShot[], ms: number): ReviewShot | undefined {
  return shots.find((s) => ms >= s.startMs && ms < s.endMs) ?? shots.at(-1);
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** One line per mark, in words, so an agent that only reads text still knows exactly where to look. */
export function describeMarks(note: DraftNote): string[] {
  const lines: string[] = [];
  if (note.region) {
    const r = note.region;
    lines.push(
      `Region: x ${pct(r.x)}, y ${pct(r.y)}, ${pct(r.w)} wide, ${pct(r.h)} high (fractions of the frame).`,
    );
  }
  note.pins.forEach((p, i) => {
    lines.push(`Pin ${i + 1}${p.label ? ` "${p.label}"` : ""}: x ${pct(p.x)}, y ${pct(p.y)}.`);
  });
  for (const s of note.strokes) {
    const a = s.points[0];
    const b = s.points.at(-1);
    if (!a || !b) continue;
    lines.push(
      s.tool === "arrow"
        ? `Arrow from (${pct(a.x)}, ${pct(a.y)}) to (${pct(b.x)}, ${pct(b.y)}).`
        : `Sketch from (${pct(a.x)}, ${pct(a.y)}) to (${pct(b.x)}, ${pct(b.y)}), see the snapshot.`,
    );
  }
  note.references.forEach((r, i) => {
    lines.push(
      `Reference ${i + 1}: ${r.url.startsWith("data:") ? "attached image" : r.url}${r.note ? `, take: ${r.note}` : ""}.`,
    );
  });
  return lines;
}

function when(note: DraftNote): string {
  return note.endMs !== undefined
    ? `${seconds(note.frameMs)} to ${seconds(note.endMs)}`
    : `at ${seconds(note.frameMs)}`;
}

/** The stored comment: a readable instruction followed by the marks in words. */
export function commentText(note: DraftNote): string {
  const head = `[${note.priority.toUpperCase()} · ${note.intent}] ${when(note)}${note.shotId ? ` (shot ${note.shotId})` : ""}: ${note.text.trim()}`;
  return [head, ...describeMarks(note)].join("\n").slice(0, 2000);
}

/** The feedback request for one note; a range note targets the time range, otherwise its shot. */
export function feedbackRequest(
  note: DraftNote,
  baseVersionId?: string,
): FeedbackRequest & { baseVersionId?: string } {
  const build = (n: DraftNote) => {
    const annotation: ReviewAnnotation = {
      intent: n.intent,
      priority: n.priority,
      frameMs: n.frameMs,
      ...(n.region ? { region: n.region } : {}),
      ...(n.pins.length ? { pins: n.pins } : {}),
      ...(n.strokes.length ? { strokes: n.strokes } : {}),
      ...(n.snapshot ? { snapshot: n.snapshot } : {}),
      ...(n.references.length ? { references: n.references } : {}),
    };
    const target =
      n.endMs !== undefined || !n.shotId
        ? { startMs: n.frameMs, endMs: Math.max(n.endMs ?? n.frameMs + 1000, n.frameMs + 1) }
        : { shotId: n.shotId };
    return {
      ...target,
      comment: commentText(n),
      annotation,
      idempotencyKey: `note-${n.id}`,
      ...(baseVersionId ? { baseVersionId } : {}),
    };
  };
  const fits = (r: ReturnType<typeof build>) => JSON.stringify(r.annotation).length <= MAX_ANNOTATION;
  // A note past the size limit loses its attached images first, then its snapshot; the text says what was sent.
  let req = build(note);
  if (fits(req)) return req;
  const linksOnly = { ...note, references: note.references.filter((r) => !r.url.startsWith("data:")) };
  req = build(linksOnly);
  return fits(req) ? req : build({ ...linksOnly, snapshot: undefined });
}

/** What a note lost to the size limit, for a warning; empty when it was sent whole. */
export function droppedImages(note: DraftNote, req: FeedbackRequest): string[] {
  const lost: string[] = [];
  if (note.snapshot && !req.annotation?.snapshot) lost.push("snapshot");
  const sentRefs = req.annotation?.references?.length ?? 0;
  if (sentRefs < note.references.length) lost.push(`${note.references.length - sentRefs} reference image(s)`);
  return lost;
}

// Mirrors the server cap on one annotation (FeedbackAnnotation in @studix/core).
const MAX_ANNOTATION = 200_000;

/** Keeps a pen stroke under the API point limit by sampling it evenly; the ends always stay. */
export function thinStroke(points: FramePoint[], max = 120): FramePoint[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]!);
}

const ORDER: Record<Priority, number> = { must: 0, should: 1, nice: 2 };

/** The revision brief for an agent: every note, most important first, plus where to read the marked frames. */
export function agentBrief(
  projectId: string,
  title: string,
  notes: DraftNote[],
  feedbackIds: string[],
): string {
  const sorted = [...notes].sort((a, b) => ORDER[a.priority] - ORDER[b.priority] || a.frameMs - b.frameMs);
  const body = sorted.map((n, i) => `${i + 1}. ${commentText(n).replace(/\n/g, "\n   ")}`).join("\n");
  return [
    `Revise the Studix video "${title}" (project ${projectId}).`,
    "Apply these review notes. MUST notes are required, SHOULD notes are expected, NICE notes are optional. Keep everything a note does not mention, and keep anything marked keep.",
    body,
    `The marked frames (region, pins, sketches and a snapshot image per note) are stored as feedback${feedbackIds.length ? ` ${feedbackIds.join(", ")}` : ""}. Read them with studix_get_project {"projectId":"${projectId}","includeFeedback":true} before you change anything, then make a new take.`,
  ].join("\n\n");
}
