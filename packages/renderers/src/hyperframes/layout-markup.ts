import type { LayoutContent, Shot } from "@studix/video-ir";
import { cssColor, TEXT_STYLES } from "./brand-tokens.ts";
import { cssRule, escapeHtml, num, seconds } from "./html-utils.ts";
import type { TimelineWriter } from "./scene-timeline.ts";
import type { ShotMarkupContext } from "./shot-markup.ts";

type LayoutShot = Extract<Shot, { type: "layout" }>;

/** HTML, CSS and the inner motion of one layout shot. */
export interface LayoutMarkup {
  html: string;
  css: string[];
  /** Writes the layout's own tweens (typing, rolling, wiring...) on the scene timeline. */
  motion: (w: TimelineWriter) => void;
}

/** Average advance of one character as a share of the font size; errs wide so text fits its box. */
const CHAR_EM = 0.6;

/**
 * Font size that keeps `chars` characters on `lines` lines of `width` px, capped at `max`. Text sizes come
 * from the box, not from the browser, so a long label shrinks instead of overflowing and nothing reflows.
 */
function fitFont(chars: number, width: number, max: number, lines = 1): number {
  return Math.max(12, Math.floor(Math.min(max, (width * lines) / (Math.max(1, chars) * CHAR_EM))));
}

const length = (text: string) => Array.from(text.normalize("NFC")).length;

/** Surfaces and ink derived from the palette, so a layout follows the scene's colours. */
const SURFACE = "color-mix(in srgb, var(--c-foreground) 8%, var(--c-background))";
const BORDER = "color-mix(in srgb, var(--c-foreground) 22%, transparent)";
const MUTED = "color-mix(in srgb, var(--c-foreground) 55%, var(--c-background))";
const ACCENT = cssColor("accent");
const heading = TEXT_STYLES.heading;
const body = TEXT_STYLES.body;

/**
 * The box a layout is drawn in: the full content width (or less on a wide frame) and about half the frame
 * height, so a headline above and captions below keep their room.
 */
export function layoutBox(frame: { width: number; height: number }): { width: number; height: number } {
  const safe = Math.round(0.07 * Math.min(frame.width, frame.height));
  const contentWidth = frame.width - 2 * safe;
  const landscape = frame.width > frame.height;
  const height = Math.round(Math.min(frame.height * (landscape ? 0.5 : 0.46), contentWidth));
  return { width: Math.min(contentWidth, Math.round(height * 2)), height };
}

/** Timing of the inner motion: it starts once the shot has entered and ends well before the shot does. */
function timing(shot: LayoutShot): { t0: number; span: number } {
  const enterMs = Math.min(shot.animation?.durationMs ?? 400, Math.floor(shot.durationMs / 2));
  const t0 = shot.startMs + enterMs;
  const span = Math.max(300, Math.min(2400, Math.round(shot.durationMs * 0.6) - enterMs));
  return { t0, span };
}

const sec = (ms: number) => seconds(Math.round(ms));

/** Grapheme-ish characters (code points after NFC, which keeps Vietnamese letters whole). */
const chars = (text: string) => Array.from(text.normalize("NFC"));

/** The thousands separator of the IR language: a dot in Vietnamese, a comma otherwise. */
const groupSep = (language: string | undefined) => (language?.startsWith("vi") ? "." : ",");

export function renderLayoutMarkup(ctx: ShotMarkupContext, shot: LayoutShot, sel: string): LayoutMarkup {
  const box = layoutBox(ctx.frame);
  const u = Math.min(box.width, box.height) / 100;
  ctx.fontWeights[heading.font].add(heading.weight);
  ctx.fontWeights[body.font].add(body.weight);
  ctx.fontWeights[body.font].add(600);
  const root = cssRule(sel, [
    "opacity: 0;",
    "position: relative;",
    `width: ${box.width}px;`,
    `height: ${box.height}px;`,
    "box-sizing: border-box;",
    `font-family: ${ctx.fontStacks.body};`,
    "color: var(--c-foreground);",
    "display: flex;",
    "flex-direction: column;",
    "align-items: center;",
    "justify-content: center;",
  ]);
  const parts = drawLayout(ctx, shot, sel, shot.layout, box, u);
  return { html: parts.html, css: [root, ...parts.css], motion: parts.motion };
}

interface Parts {
  html: string;
  css: string[];
  motion: (w: TimelineWriter) => void;
}

function drawLayout(
  ctx: ShotMarkupContext,
  shot: LayoutShot,
  sel: string,
  layout: LayoutContent,
  box: { width: number; height: number },
  u: number,
): Parts {
  const { t0, span } = timing(shot);
  const id = (suffix: string) => `${sel.slice(1)}-${suffix}`;
  const headingFont = ctx.fontStacks.heading;
  switch (layout.kind) {
    case "prompt-box": {
      const text = chars(layout.text);
      const pad = Math.round(u * 5);
      const button = Math.round(u * 13);
      const textWidth = box.width - 2 * pad - button - pad;
      const font = fitFont(text.length, textWidth, u * 7, 3);
      const css = [
        cssRule(`${sel} .pb`, [
          "display: flex;",
          "align-items: center;",
          `gap: ${pad}px;`,
          `width: ${box.width}px;`,
          "box-sizing: border-box;",
          `padding: ${pad}px;`,
          `background: ${SURFACE};`,
          `border: ${num(Math.max(2, u * 0.5))}px solid ${BORDER};`,
          `border-radius: ${Math.round(u * 6)}px;`,
        ]),
        cssRule(`${sel} .pb-text`, [
          "flex: 1 1 auto;",
          "min-width: 0;",
          `font-size: ${font}px;`,
          `line-height: ${body.lineHeight};`,
          "white-space: pre-wrap;",
          "overflow-wrap: break-word;",
          "text-align: left;",
        ]),
        cssRule(`${sel} .pb-ch`, ["opacity: 0;"]),
        cssRule(`${sel} .pb-caret`, [
          "display: inline-block;",
          `width: ${Math.max(2, Math.round(font * 0.08))}px;`,
          `height: ${Math.round(font * 1.05)}px;`,
          `margin-left: ${Math.round(font * 0.06)}px;`,
          "vertical-align: text-bottom;",
          `background: ${ACCENT};`,
          "opacity: 0;",
        ]),
        cssRule(`${sel} .pb-send`, [
          "flex: 0 0 auto;",
          "position: relative;",
          `width: ${button}px;`,
          `height: ${button}px;`,
          "border-radius: 999px;",
          `background: ${ACCENT};`,
        ]),
        cssRule(`${sel} .pb-send::after`, [
          'content: "";',
          "position: absolute;",
          "left: 50%;",
          "top: 50%;",
          `width: ${Math.round(button * 0.28)}px;`,
          `height: ${Math.round(button * 0.28)}px;`,
          `border-top: ${Math.round(button * 0.09)}px solid var(--c-background);`,
          `border-left: ${Math.round(button * 0.09)}px solid var(--c-background);`,
          "transform: translate(-50%, -25%) rotate(45deg);",
        ]),
      ];
      const spans = text.map((c, i) => `<span id="${id(`c${i}`)}" class="pb-ch">${escapeHtml(c)}</span>`);
      const html = `<div class="pb"><div class="pb-text"><span id="${id("caret0")}" class="pb-caret"></span>${spans.join("")}<span id="${id("caret1")}" class="pb-caret"></span></div><div id="${id("send")}" class="pb-send"></div></div>`;
      const typeMs = Math.min(span * 0.8, text.length * 45);
      const step = typeMs / Math.max(1, text.length);
      return {
        html,
        css,
        motion: (w) => {
          w.set(`#${id("caret0")}`, { opacity: 1 }, sec(t0 - 200));
          w.set(`#${id("caret0")}`, { opacity: 0 }, sec(t0));
          text.forEach((_, i) => {
            w.set(`#${id(`c${i}`)}`, { opacity: 1 }, sec(t0 + i * step));
          });
          const typed = t0 + typeMs;
          // The caret blinks after the last letter, then the prompt is sent.
          for (let k = 0; k < 4; k++)
            w.set(`#${id("caret1")}`, { opacity: k % 2 === 0 ? 1 : 0 }, sec(typed + k * 260));
          w.fromTo(
            `#${id("send")}`,
            { scale: 1 },
            { scale: 0.82, duration: 0.12, ease: "power2.in" },
            sec(typed + 300),
          );
          w.fromTo(
            `#${id("send")}`,
            { scale: 0.82 },
            { scale: 1, duration: 0.3, ease: "back.out(2)" },
            sec(typed + 420),
          );
        },
      };
    }
    case "code": {
      const pad = Math.round(u * 5);
      const gutter = Math.round(u * 8);
      const bar = Math.round(u * 10);
      const longest = Math.max(...layout.lines.map(length), 1);
      const lineCount = layout.lines.length;
      const font = Math.min(
        fitFont(longest, box.width - 2 * pad - gutter, u * 6.2),
        Math.floor((box.height - bar - 2 * pad) / (lineCount * 1.55)),
      );
      const dot = Math.round(u * 2.6);
      const css = [
        cssRule(`${sel} .code`, [
          `width: ${box.width}px;`,
          "box-sizing: border-box;",
          `background: ${SURFACE};`,
          `border: ${num(Math.max(2, u * 0.5))}px solid ${BORDER};`,
          `border-radius: ${Math.round(u * 4)}px;`,
          "overflow: hidden;",
        ]),
        cssRule(`${sel} .code-bar`, [
          "display: flex;",
          "align-items: center;",
          `gap: ${Math.round(dot * 0.7)}px;`,
          `height: ${bar}px;`,
          `padding: 0 ${pad}px;`,
          `border-bottom: ${num(Math.max(1, u * 0.3))}px solid ${BORDER};`,
          `font-size: ${Math.round(bar * 0.42)}px;`,
          `color: ${MUTED};`,
        ]),
        cssRule(`${sel} .code-dot`, [
          `width: ${dot}px;`,
          `height: ${dot}px;`,
          "border-radius: 999px;",
          `background: ${BORDER};`,
        ]),
        cssRule(`${sel} .code-title`, [`margin-left: ${Math.round(dot)}px;`]),
        cssRule(`${sel} .code-body`, [`padding: ${Math.round(pad * 0.7)}px 0;`]),
        cssRule(`${sel} .code-line`, [
          "position: relative;",
          "display: flex;",
          `font-size: ${font}px;`,
          "line-height: 1.55;",
          "font-variant-numeric: tabular-nums;",
          "white-space: pre;",
          "text-align: left;",
          "opacity: 0;",
        ]),
        cssRule(`${sel} .code-no`, [
          `flex: 0 0 ${gutter}px;`,
          "text-align: right;",
          `padding-right: ${Math.round(pad * 0.6)}px;`,
          "box-sizing: border-box;",
          `color: ${MUTED};`,
        ]),
        cssRule(`${sel} .code-hl`, [
          "position: absolute;",
          "inset: 0;",
          `background: color-mix(in srgb, ${ACCENT} 24%, transparent);`,
          `border-left: ${Math.max(3, Math.round(u * 0.8))}px solid ${ACCENT};`,
          "transform-origin: 0 50%;",
          "transform: scaleX(0);",
        ]),
        cssRule(`${sel} .code-tx`, ["position: relative;"]),
      ];
      const lines = layout.lines.map((line, i) => {
        const hl = layout.highlight === i ? `<div id="${id("hl")}" class="code-hl"></div>` : "";
        return `<div id="${id(`l${i}`)}" class="code-line">${hl}<span class="code-no">${i + 1}</span><span class="code-tx">${escapeHtml(line)}</span></div>`;
      });
      const title = layout.title ? `<span class="code-title">${escapeHtml(layout.title)}</span>` : "";
      const html = `<div class="code"><div class="code-bar"><span class="code-dot"></span><span class="code-dot"></span><span class="code-dot"></span>${title}</div><div class="code-body">${lines.join("")}</div></div>`;
      const step = Math.min(220, (span * 0.6) / lineCount);
      return {
        html,
        css,
        motion: (w) => {
          layout.lines.forEach((_, i) => {
            w.fromTo(
              `#${id(`l${i}`)}`,
              { opacity: 0, x: -u * 3 },
              { opacity: 1, x: 0, duration: 0.3, ease: "power3.out" },
              sec(t0 + i * step),
            );
          });
          if (layout.highlight !== undefined && layout.highlight < lineCount)
            w.fromTo(
              `#${id("hl")}`,
              { scaleX: 0 },
              { scaleX: 1, duration: 0.45, ease: "power3.inOut" },
              sec(t0 + lineCount * step + 200),
            );
        },
      };
    }
    case "chips": {
      const n = layout.items.length;
      const hubW = Math.round(box.width * 0.36);
      const hubH = Math.round(Math.min(box.height * 0.32, u * 26));
      const chipX = Math.round(box.width * 0.6);
      const chipW = box.width - chipX;
      const pitch = box.height / n;
      const chipH = Math.round(Math.min(pitch * 0.72, u * 18));
      const hubY = Math.round((box.height - hubH) / 2);
      const line = Math.max(2, Math.round(u * 0.6));
      const chipFont = Math.min(
        ...layout.items.map((t) => fitFont(length(t), chipW - u * 8, Math.min(u * 6, chipH * 0.5))),
      );
      const hubFont = fitFont(length(layout.hub), hubW - u * 8, Math.min(u * 7.5, hubH * 0.42));
      const css = [
        cssRule(`${sel} .ch`, ["position: relative;", `width: ${box.width}px;`, `height: ${box.height}px;`]),
        cssRule(`${sel} .ch-hub, ${sel} .ch-chip`, [
          "position: absolute;",
          "display: flex;",
          "align-items: center;",
          "justify-content: center;",
          "box-sizing: border-box;",
          "text-align: center;",
          "white-space: nowrap;",
          "opacity: 0;",
        ]),
        cssRule(`${sel} .ch-hub`, [
          `left: 0;`,
          `top: ${hubY}px;`,
          `width: ${hubW}px;`,
          `height: ${hubH}px;`,
          `border-radius: ${Math.round(u * 4)}px;`,
          `background: ${ACCENT};`,
          "color: var(--c-background);",
          `font-family: ${headingFont};`,
          `font-weight: ${heading.weight};`,
          `font-size: ${hubFont}px;`,
        ]),
        cssRule(`${sel} .ch-chip`, [
          `left: ${chipX}px;`,
          `width: ${chipW}px;`,
          `height: ${chipH}px;`,
          "border-radius: 999px;",
          `background: ${SURFACE};`,
          `border: ${line}px solid ${BORDER};`,
          `font-size: ${chipFont}px;`,
          "font-weight: 600;",
        ]),
        cssRule(`${sel} .ch-wire`, ["position: absolute;", `height: ${line}px;`, "transform-origin: 0 50%;"]),
        cssRule(`${sel} .ch-wire > div`, [
          "width: 100%;",
          "height: 100%;",
          `background: ${ACCENT};`,
          "transform-origin: 0 50%;",
          "transform: scaleX(0);",
        ]),
      ];
      const from = { x: hubW, y: box.height / 2 };
      const wires: string[] = [];
      const chips: string[] = [];
      layout.items.forEach((item, i) => {
        const cy = pitch * (i + 0.5);
        const dx = chipX - from.x;
        const dy = cy - from.y;
        const len = Math.hypot(dx, dy);
        const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        wires.push(
          `<div class="ch-wire" style="left: ${num(from.x)}px; top: ${num(from.y - line / 2)}px; width: ${num(len)}px; transform: rotate(${num(angle)}deg);"><div id="${id(`w${i}`)}"></div></div>`,
        );
        chips.push(
          `<div id="${id(`c${i}`)}" class="ch-chip" style="top: ${num(cy - chipH / 2)}px;">${escapeHtml(item)}</div>`,
        );
      });
      const html = `<div class="ch">${wires.join("")}<div id="${id("hub")}" class="ch-hub">${escapeHtml(layout.hub)}</div>${chips.join("")}</div>`;
      const step = Math.min(260, (span * 0.6) / n);
      return {
        html,
        css,
        motion: (w) => {
          w.fromTo(
            `#${id("hub")}`,
            { opacity: 0, scale: 0.8 },
            { opacity: 1, scale: 1, duration: 0.35, ease: "back.out(1.7)" },
            sec(t0),
          );
          layout.items.forEach((_, i) => {
            const at = t0 + 300 + i * step;
            w.fromTo(
              `#${id(`w${i}`)}`,
              { scaleX: 0 },
              { scaleX: 1, duration: 0.35, ease: "power2.inOut" },
              sec(at),
            );
            w.fromTo(
              `#${id(`c${i}`)}`,
              { opacity: 0, x: u * 4 },
              { opacity: 1, x: 0, duration: 0.3, ease: "power3.out" },
              sec(at + 250),
            );
          });
        },
      };
    }
    case "checklist": {
      const n = layout.items.length;
      const longest = Math.max(...layout.items.map((i) => length(i.label)));
      const icon = Math.round(Math.min(u * 12, (box.height / n) * 0.55));
      const gap = Math.round(icon * 0.5);
      const font = Math.min(
        fitFont(longest, box.width - icon - gap - u * 4, u * 8.5),
        Math.round(icon * 0.8),
      );
      const ring = Math.max(2, Math.round(icon * 0.1));
      const css = [
        cssRule(`${sel} .cl`, [
          "display: flex;",
          "flex-direction: column;",
          `gap: ${Math.round(Math.min(icon * 0.6, (box.height - n * icon) / Math.max(1, n)))}px;`,
          // As wide as its longest step, so the list sits centred under the headline.
          "width: fit-content;",
          `max-width: ${box.width}px;`,
        ]),
        cssRule(`${sel} .cl-row`, [
          "display: flex;",
          "align-items: center;",
          `gap: ${gap}px;`,
          "opacity: 0;",
        ]),
        cssRule(`${sel} .cl-icon`, [
          "position: relative;",
          `flex: 0 0 ${icon}px;`,
          `height: ${icon}px;`,
          "box-sizing: border-box;",
          "border-radius: 999px;",
          `border: ${ring}px solid ${MUTED};`,
        ]),
        cssRule(`${sel} .cl-done .cl-icon, ${sel} .cl-active .cl-icon`, [`border-color: ${ACCENT};`]),
        cssRule(`${sel} .cl-fill`, [
          "position: absolute;",
          `inset: -${ring}px;`,
          "border-radius: 999px;",
          `background: ${ACCENT};`,
          "transform: scale(0);",
        ]),
        cssRule(`${sel} .cl-fill::after`, [
          'content: "";',
          "position: absolute;",
          "left: 50%;",
          "top: 46%;",
          `width: ${Math.round(icon * 0.22)}px;`,
          `height: ${Math.round(icon * 0.42)}px;`,
          `border-right: ${Math.max(2, Math.round(icon * 0.1))}px solid var(--c-background);`,
          `border-bottom: ${Math.max(2, Math.round(icon * 0.1))}px solid var(--c-background);`,
          "transform: translate(-50%, -50%) rotate(45deg);",
        ]),
        cssRule(`${sel} .cl-dot`, [
          "position: absolute;",
          "inset: 25%;",
          "border-radius: 999px;",
          `background: ${ACCENT};`,
          "opacity: 0;",
        ]),
        cssRule(`${sel} .cl-label`, [
          `font-size: ${font}px;`,
          `line-height: ${body.lineHeight};`,
          "text-align: left;",
          "white-space: nowrap;",
        ]),
        cssRule(`${sel} .cl-todo .cl-label`, [`color: ${MUTED};`]),
        cssRule(`${sel} .cl-active .cl-label`, ["font-weight: 600;"]),
      ];
      const rows = layout.items.map((item, i) => {
        const inner =
          item.state === "done"
            ? `<div id="${id(`f${i}`)}" class="cl-fill"></div>`
            : item.state === "active"
              ? `<div id="${id(`d${i}`)}" class="cl-dot"></div>`
              : "";
        return `<div id="${id(`r${i}`)}" class="cl-row cl-${item.state}"><div class="cl-icon">${inner}</div><div class="cl-label">${escapeHtml(item.label)}</div></div>`;
      });
      const step = Math.min(380, (span * 0.75) / n);
      return {
        html: `<div class="cl">${rows.join("")}</div>`,
        css,
        motion: (w) => {
          layout.items.forEach((item, i) => {
            const at = t0 + i * step;
            w.fromTo(
              `#${id(`r${i}`)}`,
              { opacity: 0, y: u * 3 },
              { opacity: 1, y: 0, duration: 0.3, ease: "power3.out" },
              sec(at),
            );
            if (item.state === "done")
              w.fromTo(
                `#${id(`f${i}`)}`,
                { scale: 0 },
                { scale: 1, duration: 0.3, ease: "back.out(2)" },
                sec(at + 200),
              );
            if (item.state === "active")
              // The step in progress pulses a few times, then stays lit.
              for (let k = 0; k < 3; k++)
                w.fromTo(
                  `#${id(`d${i}`)}`,
                  { opacity: k === 0 ? 0 : 0.25 },
                  { opacity: 1, duration: 0.35, ease: "sine.inOut" },
                  sec(at + 200 + k * 500),
                );
          });
        },
      };
    }
    case "counter": {
      const sep = groupSep(ctx.language);
      const digits = String(layout.to);
      const fromDigits = String(layout.from).padStart(digits.length, "0").slice(-digits.length);
      // Digits with group separators, as they read: 12500 -> 12.500 / 12,500.
      const cells: Array<{ digit: number; from: number } | string> = [];
      [...digits].forEach((d, i) => {
        const left = digits.length - i;
        if (i > 0 && left % 3 === 0) cells.push(sep);
        cells.push({ digit: Number(d), from: Number(fromDigits[i]) });
      });
      const prefix = layout.prefix ?? "";
      const suffix = layout.suffix ?? "";
      const total = cells.length + length(prefix) + length(suffix);
      const labelFont = layout.label ? fitFont(length(layout.label), box.width, u * 7) : 0;
      const font = Math.min(
        fitFont(total, box.width, u * 34),
        Math.floor((box.height - labelFont * 2) / 1.3),
      );
      const cellH = Math.round(font * 1.2);
      const css = [
        cssRule(`${sel} .ct`, [
          "display: flex;",
          "align-items: center;",
          `height: ${cellH}px;`,
          `font-family: ${headingFont};`,
          `font-weight: ${heading.weight};`,
          `font-size: ${font}px;`,
          "line-height: 1.2;",
          "font-variant-numeric: tabular-nums;",
          "white-space: nowrap;",
        ]),
        cssRule(`${sel} .ct-col`, [
          "display: inline-block;",
          "width: 0.62em;",
          `height: ${cellH}px;`,
          "overflow: hidden;",
          "text-align: center;",
        ]),
        cssRule(`${sel} .ct-strip > div`, [`height: ${cellH}px;`]),
        cssRule(`${sel} .ct-fix`, [`color: ${ACCENT};`]),
        cssRule(`${sel} .ct-label`, [
          `font-size: ${labelFont}px;`,
          `margin-top: ${Math.round(labelFont * 0.5)}px;`,
          `color: ${MUTED};`,
          "text-align: center;",
          "opacity: 0;",
        ]),
      ];
      const ten = Array.from({ length: 10 }, (_, d) => `<div>${d}</div>`).join("");
      const rolls: Array<{ id: string; from: number; to: number }> = [];
      let changed = false;
      const html = cells
        .map((cell, i) => {
          if (typeof cell === "string") return `<span>${escapeHtml(cell)}</span>`;
          // Once a higher digit changes, every lower one spins a full turn on its way, like an odometer.
          changed ||= cell.digit !== cell.from;
          const roll = { id: id(`d${i}`), from: cell.from, to: cell.digit + (changed ? 10 : 0) };
          rolls.push(roll);
          return `<span class="ct-col"><div id="${roll.id}" class="ct-strip" style="transform: translateY(${-roll.from * cellH}px);">${ten}${ten}</div></span>`;
        })
        .join("");
      const fix = (text: string) => (text ? `<span class="ct-fix">${escapeHtml(text)}</span>` : "");
      const label = layout.label
        ? `<div id="${id("label")}" class="ct-label">${escapeHtml(layout.label)}</div>`
        : "";
      return {
        html: `<div class="ct">${fix(prefix)}${html}${fix(suffix)}</div>${label}`,
        css,
        motion: (w) => {
          const d = seconds(Math.max(600, span * 0.8));
          rolls.forEach((r, i) => {
            w.fromTo(
              `#${r.id}`,
              { y: -r.from * cellH },
              { y: -r.to * cellH, duration: d, ease: "power3.out" },
              // Higher digits settle a touch earlier than the lower ones.
              sec(t0 + (rolls.length - 1 - i) * 40),
            );
          });
          if (layout.label)
            w.fromTo(
              `#${id("label")}`,
              { opacity: 0, y: u * 3 },
              { opacity: 1, y: 0, duration: 0.35, ease: "power3.out" },
              sec(t0 + 200),
            );
        },
      };
    }
    case "cards-row": {
      const n = layout.items.length;
      const wide = box.width / box.height > 1.3;
      const gap = Math.round(u * 4);
      const cardW = wide ? Math.floor((box.width - gap * (n - 1)) / n) : box.width;
      const cardH = wide
        ? Math.round(Math.min(box.height * 0.8, cardW * 1.25))
        : Math.floor((box.height - gap * (n - 1)) / n);
      const longest = Math.max(...layout.items.map(length));
      const lines = wide ? 3 : 1;
      const font = Math.min(fitFont(longest, cardW - u * 8, u * 6.5, lines), Math.round(cardH * 0.36));
      const css = [
        cssRule(`${sel} .cr`, [
          "display: flex;",
          `flex-direction: ${wide ? "row" : "column"};`,
          `gap: ${gap}px;`,
          "align-items: center;",
        ]),
        cssRule(`${sel} .cr-card`, [
          "position: relative;",
          "display: flex;",
          "align-items: center;",
          "justify-content: center;",
          "box-sizing: border-box;",
          `width: ${cardW}px;`,
          `height: ${cardH}px;`,
          `padding: ${Math.round(u * 3)}px;`,
          `background: ${SURFACE};`,
          `border-radius: ${Math.round(u * 4)}px;`,
          `font-size: ${font}px;`,
          "font-weight: 600;",
          `line-height: ${heading.lineHeight};`,
          "text-align: center;",
          "overflow-wrap: break-word;",
          "hyphens: manual;",
          "opacity: 0;",
        ]),
        cssRule(`${sel} .cr-ring`, [
          "position: absolute;",
          "inset: 0;",
          `border: ${Math.max(3, Math.round(u * 0.9))}px solid ${ACCENT};`,
          "border-radius: inherit;",
          "opacity: 0;",
        ]),
        cssRule(`${sel} .cr-text`, ["position: relative;"]),
      ];
      const focus = layout.focus !== undefined && layout.focus < n ? layout.focus : undefined;
      const cards = layout.items.map((item, i) => {
        const ring = i === focus ? `<div id="${id("ring")}" class="cr-ring"></div>` : "";
        return `<div id="${id(`k${i}`)}" class="cr-card">${ring}<span class="cr-text">${escapeHtml(item)}</span></div>`;
      });
      const step = Math.min(200, (span * 0.5) / n);
      return {
        html: `<div class="cr">${cards.join("")}</div>`,
        css,
        motion: (w) => {
          layout.items.forEach((_, i) => {
            w.fromTo(
              `#${id(`k${i}`)}`,
              { opacity: 0, y: u * 5 },
              { opacity: 1, y: 0, duration: 0.35, ease: "power3.out" },
              sec(t0 + i * step),
            );
          });
          if (focus === undefined) return;
          const at = sec(t0 + n * step + 300);
          layout.items.forEach((_, i) => {
            if (i === focus)
              w.fromTo(
                `#${id(`k${i}`)}`,
                { scale: 1 },
                { scale: 1.06, duration: 0.4, ease: "power2.out" },
                at,
              );
            else
              w.fromTo(
                `#${id(`k${i}`)}`,
                { opacity: 1 },
                { opacity: 0.45, duration: 0.4, ease: "power2.out" },
                at,
              );
          });
          w.fromTo(`#${id("ring")}`, { opacity: 0 }, { opacity: 1, duration: 0.4, ease: "power2.out" }, at);
        },
      };
    }
    case "swatches": {
      const n = layout.colors.length;
      const wide = box.width / box.height > 1.3;
      const cols = wide ? n : Math.min(n, 3);
      const rows = Math.ceil(n / cols);
      const gap = Math.round(u * 4);
      const named = layout.colors.some((c) => c.name);
      const labelFont = named ? Math.round(u * 4.6) : 0;
      const cellH = (box.height - gap * (rows - 1)) / rows;
      const tile = Math.floor(
        Math.min((box.width - gap * (cols - 1)) / cols, cellH - labelFont * 2.2, u * 40),
      );
      const fit = Math.min(
        labelFont,
        ...layout.colors.map((c) => (c.name ? fitFont(length(c.name), tile + gap, labelFont) : labelFont)),
      );
      const css = [
        cssRule(`${sel} .sw`, [
          "display: grid;",
          `grid-template-columns: repeat(${cols}, ${tile}px);`,
          `gap: ${gap}px;`,
          "justify-content: center;",
        ]),
        cssRule(`${sel} .sw-item`, [
          "display: flex;",
          "flex-direction: column;",
          "align-items: center;",
          `gap: ${Math.round(labelFont * 0.5)}px;`,
        ]),
        cssRule(`${sel} .sw-tile`, [
          `width: ${tile}px;`,
          `height: ${tile}px;`,
          `border-radius: ${Math.round(tile * 0.18)}px;`,
          `border: ${Math.max(2, Math.round(u * 0.4))}px solid ${BORDER};`,
          "box-sizing: border-box;",
          "transform: scale(0);",
        ]),
        cssRule(`${sel} .sw-name`, [
          `font-size: ${fit}px;`,
          "white-space: nowrap;",
          "font-weight: 600;",
          "opacity: 0;",
        ]),
      ];
      const items = layout.colors.map((c, i) => {
        const name = c.name ? `<div id="${id(`n${i}`)}" class="sw-name">${escapeHtml(c.name)}</div>` : "";
        return `<div class="sw-item"><div id="${id(`t${i}`)}" class="sw-tile" style="background: ${cssColor(c.color)};"></div>${name}</div>`;
      });
      const step = Math.min(160, (span * 0.5) / n);
      return {
        html: `<div class="sw">${items.join("")}</div>`,
        css,
        motion: (w) => {
          layout.colors.forEach((c, i) => {
            const at = t0 + i * step;
            w.fromTo(
              `#${id(`t${i}`)}`,
              { scale: 0 },
              { scale: 1, duration: 0.35, ease: "back.out(1.7)" },
              sec(at),
            );
            if (c.name)
              w.fromTo(
                `#${id(`n${i}`)}`,
                { opacity: 0 },
                { opacity: 1, duration: 0.3, ease: "power2.out" },
                sec(at + 200),
              );
          });
        },
      };
    }
    case "stat": {
      const labelFont = fitFont(length(layout.label), box.width, u * 7, 2);
      const font = Math.min(
        fitFont(length(layout.value), box.width, u * 40),
        Math.floor((box.height - labelFont * 3.5) / 1.2),
      );
      const css = [
        cssRule(`${sel} .st-value`, [
          `font-family: ${headingFont};`,
          `font-weight: ${heading.weight};`,
          `font-size: ${font}px;`,
          "line-height: 1.2;",
          "font-variant-numeric: tabular-nums;",
          "white-space: nowrap;",
          `color: ${ACCENT};`,
          "opacity: 0;",
        ]),
        cssRule(`${sel} .st-rule`, [
          `width: ${Math.round(Math.min(box.width * 0.4, font * 2))}px;`,
          `height: ${Math.max(3, Math.round(u * 1))}px;`,
          `margin: ${Math.round(labelFont * 0.4)}px 0;`,
          "border-radius: 999px;",
          `background: ${ACCENT};`,
          "transform: scaleX(0);",
        ]),
        cssRule(`${sel} .st-label`, [
          `font-size: ${labelFont}px;`,
          `line-height: ${body.lineHeight};`,
          "text-align: center;",
          "text-wrap: balance;",
          "opacity: 0;",
        ]),
      ];
      return {
        html: `<div id="${id("value")}" class="st-value">${escapeHtml(layout.value)}</div><div id="${id("rule")}" class="st-rule"></div><div id="${id("label")}" class="st-label">${escapeHtml(layout.label)}</div>`,
        css,
        motion: (w) => {
          w.fromTo(
            `#${id("value")}`,
            { opacity: 0, scale: 0.7 },
            { opacity: 1, scale: 1, duration: 0.5, ease: "back.out(1.6)" },
            sec(t0),
          );
          w.fromTo(
            `#${id("rule")}`,
            { scaleX: 0 },
            { scaleX: 1, duration: 0.45, ease: "power3.inOut" },
            sec(t0 + 300),
          );
          w.fromTo(
            `#${id("label")}`,
            { opacity: 0, y: u * 3 },
            { opacity: 1, y: 0, duration: 0.35, ease: "power3.out" },
            sec(t0 + 450),
          );
        },
      };
    }
  }
}
