import { type PointerEvent, useRef, useState } from "react";
import type { FramePoint } from "../../api-client.ts";
import { type DraftNote, type Tool, thinStroke } from "./review-notes.ts";

// One note is one feedback request (API body limit 256 KB): a snapshot plus six image references must fit.
const SNAPSHOT_MAX = 90_000;
const REFERENCE_MAX = 25_000;

const clamp = (v: number) => Math.min(1, Math.max(0, v));

function pathOf(points: FramePoint[]): string {
  return points.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");
}

/** The marks of a note, drawn in frame fractions (the SVG viewBox is 0..1 on both axes). */
export function Marks({ note }: { note: Pick<DraftNote, "region" | "pins" | "strokes"> }) {
  return (
    <>
      {note.region && (
        <rect
          className="mark-region"
          x={note.region.x}
          y={note.region.y}
          width={note.region.w}
          height={note.region.h}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {note.strokes.map((s, i) => (
        <path
          // biome-ignore lint/suspicious/noArrayIndexKey: strokes are append-only.
          key={i}
          className={`mark-stroke${s.tool === "arrow" ? " arrow" : ""}`}
          d={pathOf(s.tool === "arrow" ? [s.points[0]!, s.points.at(-1)!] : s.points)}
          vectorEffect="non-scaling-stroke"
          markerEnd={s.tool === "arrow" ? "url(#mark-arrow)" : undefined}
        />
      ))}
    </>
  );
}

/**
 * Drawing surface over the paused frame. Box drags a region, pin drops a numbered point, pen and arrow
 * record a stroke. Everything is stored as fractions of the frame, so it maps to any render size.
 */
export function AnnotateLayer({
  tool,
  note,
  onChange,
}: {
  tool: Tool;
  note: DraftNote;
  onChange: (next: DraftNote) => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<FramePoint[] | null>(null);

  function point(e: PointerEvent): FramePoint {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    const r = (v: number) => Math.round(v * 1000) / 1000;
    return {
      x: r(clamp((e.clientX - box.left) / box.width)),
      y: r(clamp((e.clientY - box.top) / box.height)),
    };
  }

  function down(e: PointerEvent<SVGSVGElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = point(e);
    if (tool === "pin") {
      onChange({ ...note, pins: [...note.pins, p].slice(0, 20) });
      return;
    }
    setDrag([p]);
  }

  function move(e: PointerEvent<SVGSVGElement>) {
    if (!drag) return;
    const p = point(e);
    setDrag(tool === "pen" ? (drag.length < 400 ? [...drag, p] : drag) : [drag[0]!, p]);
  }

  function up() {
    if (!drag) return;
    const [a, b] = [drag[0]!, drag.at(-1)!];
    if (tool === "box" && Math.abs(b.x - a.x) > 0.01 && Math.abs(b.y - a.y) > 0.01) {
      onChange({
        ...note,
        region: {
          x: Math.min(a.x, b.x),
          y: Math.min(a.y, b.y),
          w: Math.abs(b.x - a.x),
          h: Math.abs(b.y - a.y),
        },
      });
    } else if ((tool === "pen" || tool === "arrow") && drag.length > 1) {
      onChange({ ...note, strokes: [...note.strokes, { tool, points: thinStroke(drag) }].slice(0, 30) });
    }
    setDrag(null);
  }

  const preview: DraftNote = drag
    ? tool === "box"
      ? {
          ...note,
          region: {
            x: Math.min(drag[0]!.x, drag.at(-1)!.x),
            y: Math.min(drag[0]!.y, drag.at(-1)!.y),
            w: Math.abs(drag.at(-1)!.x - drag[0]!.x),
            h: Math.abs(drag.at(-1)!.y - drag[0]!.y),
          },
        }
      : { ...note, strokes: [...note.strokes, { tool: tool === "arrow" ? "arrow" : "pen", points: drag }] }
    : note;

  return (
    <svg
      ref={ref}
      className={`annotate-layer tool-${tool}`}
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      role="application"
      aria-label={`Draw on the frame with the ${tool} tool`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => setDrag(null)}
    >
      <defs>
        <marker
          id="mark-arrow"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0 0 L10 5 L0 10 z" className="mark-arrowhead" />
        </marker>
      </defs>
      <Marks note={preview} />
    </svg>
  );
}

/** Numbered pins are HTML, so they stay round on any frame aspect ratio. */
export function Pins({ pins }: { pins: DraftNote["pins"] }) {
  return (
    <>
      {pins.map((p, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: pins are numbered by position.
          key={i}
          className="mark-pin"
          style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
        >
          {i + 1}
        </span>
      ))}
    </>
  );
}

/**
 * The paused frame with the marks burned in, as a JPEG data URL small enough for one feedback request.
 * Returns undefined when the video host does not allow frame capture (no CORS), so the note still goes out.
 */
export function snapshot(video: HTMLVideoElement, note: DraftNote): string | undefined {
  const scale = Math.min(1, 720 / (video.videoWidth || 720));
  const w = Math.round((video.videoWidth || 720) * scale);
  const h = Math.round((video.videoHeight || 405) * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  if (!g) return undefined;
  try {
    g.drawImage(video, 0, 0, w, h);
    g.strokeStyle = "#ff3b30";
    g.fillStyle = "#ff3b30";
    g.lineWidth = Math.max(3, w / 240);
    g.lineCap = "round";
    g.lineJoin = "round";
    if (note.region) g.strokeRect(note.region.x * w, note.region.y * h, note.region.w * w, note.region.h * h);
    for (const s of note.strokes) {
      const pts = s.tool === "arrow" ? [s.points[0]!, s.points.at(-1)!] : s.points;
      g.beginPath();
      pts.forEach((p, i) => {
        if (i) g.lineTo(p.x * w, p.y * h);
        else g.moveTo(p.x * w, p.y * h);
      });
      g.stroke();
      if (s.tool === "arrow") {
        const [a, b] = [pts[0]!, pts[1]!];
        const angle = Math.atan2((b.y - a.y) * h, (b.x - a.x) * w);
        const size = g.lineWidth * 4;
        g.beginPath();
        g.moveTo(b.x * w, b.y * h);
        g.lineTo(b.x * w - size * Math.cos(angle - 0.5), b.y * h - size * Math.sin(angle - 0.5));
        g.lineTo(b.x * w - size * Math.cos(angle + 0.5), b.y * h - size * Math.sin(angle + 0.5));
        g.fill();
      }
    }
    note.pins.forEach((p, i) => {
      const r = Math.max(10, w / 70);
      g.beginPath();
      g.arc(p.x * w, p.y * h, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#fff";
      g.font = `600 ${r}px sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(i + 1), p.x * w, p.y * h);
      g.fillStyle = "#ff3b30";
    });
    for (const quality of [0.8, 0.6, 0.45]) {
      const url = canvas.toDataURL("image/jpeg", quality);
      if (url.length <= SNAPSHOT_MAX) return url;
    }
    return undefined;
  } catch {
    // A cross-origin video without CORS taints the canvas.
    return undefined;
  }
}

/** A reference image, downscaled so it fits a feedback request. */
export async function imageFileToDataUrl(file: File): Promise<string | undefined> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.8, 0.6, 0.4]) {
    const url = canvas.toDataURL("image/jpeg", quality);
    if (url.length <= REFERENCE_MAX) return url;
  }
  return undefined;
}
