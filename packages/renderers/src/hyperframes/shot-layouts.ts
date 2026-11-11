import type { ShotLayout } from "@studix/video-ir";
import { cssRule, escapeHtml, num } from "./html-utils.ts";
import {
  graphemes,
  type LayoutDevice,
  type LayoutKit,
  type LayoutOf,
  type LayoutTiming,
  sec,
} from "./shot-layout-kit.ts";

/**
 * The motion-design devices a title or text shot can carry under its headline. Each returns its markup,
 * CSS and a GSAP choreography placed at absolute positions inside the shot window. Only opacity,
 * transforms and clip-path animate, so seeking to any frame is exact (see scene-timeline.ts).
 */
export function layoutDevice(kit: LayoutKit, layout: ShotLayout): LayoutDevice {
  switch (layout.kind) {
    case "prompt-box":
      return promptBox(kit, layout);
    case "code":
      return code(kit, layout);
    case "chips":
      return chips(kit, layout);
    case "checklist":
      return checklist(kit, layout);
    case "counter":
      return counter(kit, layout);
    case "cards-row":
      return cardsRow(kit, layout);
    case "swatches":
      return swatches(kit, layout);
    case "stat":
      return stat(kit, layout);
  }
}

const REVEAL_HIDDEN = "inset(0% 100% 0% 0%)";
const REVEAL_SHOWN = "inset(0% 0% 0% 0%)";

/** A rounded panel in the scene's surface colour. */
const panel = (kit: LayoutKit, radius: number): string[] => [
  `background: ${kit.colors.surface};`,
  `border: ${Math.max(1, kit.px(2))}px solid ${kit.colors.line};`,
  `border-radius: ${kit.px(radius)}px;`,
  "box-sizing: border-box;",
];

/** Element rises into place: the common entrance of a device part. */
function rise(w: Parameters<LayoutDevice["motion"]>[0], target: string, at: number, travel: number): void {
  w.fromTo(
    target,
    { opacity: 0, y: travel },
    { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" },
    sec(at),
  );
}

function promptBox(kit: LayoutKit, layout: LayoutOf<"prompt-box">): LayoutDevice {
  const { sel, px, colors } = kit;
  const chars = graphemes(layout.text);
  // At most ~36 key presses, so a long prompt types in groups and the timeline stays small.
  const per = Math.max(1, Math.ceil(chars.length / 36));
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += per) groups.push(chars.slice(i, i + per).join(""));
  const caret = '<i class="pb-caret"></i>';
  const typed = [
    `<span class="pb-g pb-g-0">${caret}</span>`,
    ...groups.map((g, i) => `<span class="pb-g pb-g-${i + 1}">${escapeHtml(g)}${caret}</span>`),
  ].join("");
  const arrow =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const send = px(78);
  const css = [
    cssRule(`${sel} .pb-box`, [
      ...panel(kit, 30),
      `width: ${kit.width}px;`,
      "display: flex;",
      "align-items: flex-end;",
      `gap: ${px(24)}px;`,
      `padding: ${px(30)}px ${px(30)}px ${px(30)}px ${px(40)}px;`,
      `box-shadow: 0 ${px(24)}px ${px(60)}px rgba(0, 0, 0, 0.28);`,
    ]),
    cssRule(`${sel} .pb-text`, [
      ...kit.font("body", kit.portrait ? 46 : 42, 500),
      "flex: 1 1 auto;",
      "line-height: 1.4;",
      "text-align: left;",
      `min-height: ${px(118)}px;`,
      "color: var(--c-foreground);",
      "overflow-wrap: break-word;",
    ]),
    cssRule(`${sel} .pb-g`, ["position: relative;", "opacity: 0;"]),
    cssRule(`${sel} .pb-g-0`, ["opacity: 1;"]),
    cssRule(`${sel} .pb-caret`, [
      "position: absolute;",
      `right: ${-px(4)}px;`,
      "top: 0.12em;",
      "bottom: 0.08em;",
      `width: ${Math.max(2, px(4))}px;`,
      `background: ${colors.accentInk};`,
      "opacity: 0;",
    ]),
    cssRule(`${sel} .pb-send`, [
      "position: relative;",
      "flex: 0 0 auto;",
      `width: ${send}px;`,
      `height: ${send}px;`,
      "border-radius: 50%;",
      "background: var(--c-accent);",
      `color: ${colors.onAccent};`,
      "display: grid;",
      "place-items: center;",
    ]),
    cssRule(`${sel} .pb-send svg`, [`width: ${px(38)}px;`, `height: ${px(38)}px;`]),
    cssRule(`${sel} .pb-ring`, [
      "position: absolute;",
      "inset: 0;",
      "border-radius: 50%;",
      `border: ${px(4)}px solid var(--c-accent);`,
      "opacity: 0;",
    ]),
  ];
  const html = `<div class="lay lay-prompt-box"><div class="pb-box"><div class="pb-text">${typed}</div><div class="pb-send"><span class="pb-ring"></span>${arrow}</div></div></div>`;
  return {
    html,
    css,
    motion: (w, t) => {
      rise(w, `${sel} .pb-box`, t.t0, px(40));
      const typeStart = t.t0 + 0.35;
      const typeDur = Math.min(Math.max(groups.length * 0.05, 0.5), Math.max(0.4, t.budget * 0.75));
      const step = typeDur / Math.max(1, groups.length);
      const caretOf = (i: number) => `${sel} .pb-g-${i} > .pb-caret`;
      w.set(caretOf(0), { opacity: 1 }, sec(t.t0 + 0.1));
      groups.forEach((_, k) => {
        const at = sec(typeStart + k * step);
        w.set(`${sel} .pb-g-${k + 1}`, { opacity: 1 }, at);
        w.set(caretOf(k + 1), { opacity: 1 }, at);
        w.set(caretOf(k), { opacity: 0 }, at);
      });
      const typed = typeStart + groups.length * step;
      // Send: a small press (anticipation), a springy release and a ring that spreads out.
      w.fromTo(
        `${sel} .pb-send`,
        { scale: 1 },
        { scale: 0.84, duration: 0.14, ease: "power2.in" },
        sec(typed + 0.15),
      );
      w.fromTo(
        `${sel} .pb-send`,
        { scale: 0.84 },
        { scale: 1, duration: 0.45, ease: "back.out(3)" },
        sec(typed + 0.29),
      );
      w.fromTo(
        `${sel} .pb-ring`,
        { opacity: 0.8, scale: 1 },
        { opacity: 0, scale: 1.8, duration: 0.6, ease: "power2.out" },
        sec(typed + 0.29),
      );
      // The caret blinks through the hold (explicit sets: no repeats on a seek-driven timeline).
      const last = caretOf(groups.length);
      let on = false;
      for (let at = typed + 0.5, n = 0; at < t.holdEnd && n < 24; at += 0.5, n++) {
        w.set(last, { opacity: on ? 1 : 0 }, sec(at));
        on = !on;
      }
    },
  };
}

/** Splits a code line into plain text and quoted strings, so strings can carry the accent. */
function codeTokens(line: string): string {
  return line
    .split(/("[^"]*"|'[^']*')/)
    .filter(Boolean)
    .map((part) => (/^["']/.test(part) ? `<span class="cd-s">${escapeHtml(part)}</span>` : escapeHtml(part)))
    .join("");
}

function code(kit: LayoutKit, layout: LayoutOf<"code">): LayoutDevice {
  const { sel, px, colors } = kit;
  const width = Math.min(kit.width, px(1100));
  const lineH = px(kit.portrait ? 60 : 58);
  const lines = layout.lines.map(
    (l, i) =>
      `<div class="cd-ln cd-ln-${i}">${i === layout.highlight ? '<span class="cd-hl"></span>' : ""}<span class="cd-no">${i + 1}</span><span class="cd-tx">${codeTokens(l) || "&nbsp;"}</span></div>`,
  );
  const dots = ["#ff5f57", "#febc2e", "#28c840"].map((c) => `<i style="background: ${c};"></i>`).join("");
  const css = [
    cssRule(`${sel} .cd-win`, [
      ...panel(kit, 26),
      `width: ${width}px;`,
      "overflow: hidden;",
      "text-align: left;",
      `box-shadow: 0 ${px(24)}px ${px(60)}px rgba(0, 0, 0, 0.3);`,
    ]),
    cssRule(`${sel} .cd-bar`, [
      "display: flex;",
      `gap: ${px(12)}px;`,
      `padding: ${px(22)}px ${px(26)}px;`,
      `border-bottom: ${Math.max(1, px(2))}px solid ${colors.line};`,
    ]),
    cssRule(`${sel} .cd-bar i`, [
      "display: block;",
      `width: ${px(18)}px;`,
      `height: ${px(18)}px;`,
      "border-radius: 50%;",
    ]),
    cssRule(`${sel} .cd-body`, [`padding: ${px(20)}px 0 ${px(26)}px;`]),
    cssRule(`${sel} .cd-ln`, [
      ...kit.font("body", kit.portrait ? 34 : 34, 500),
      "position: relative;",
      "display: flex;",
      `height: ${lineH}px;`,
      "align-items: center;",
      "white-space: pre;",
      "font-variant-numeric: tabular-nums;",
      "color: var(--c-foreground);",
      `clip-path: ${REVEAL_HIDDEN};`,
    ]),
    cssRule(`${sel} .cd-no`, [
      `width: ${px(76)}px;`,
      "flex: 0 0 auto;",
      "text-align: right;",
      `padding-right: ${px(26)}px;`,
      `color: ${colors.muted};`,
      "position: relative;",
    ]),
    cssRule(`${sel} .cd-tx`, ["position: relative;", "overflow: hidden;", "text-overflow: ellipsis;"]),
    cssRule(`${sel} .cd-s`, [`color: ${colors.accentInk};`]),
    cssRule(`${sel} .cd-hl`, [
      "position: absolute;",
      "inset: 0;",
      `background: ${colors.accentTint};`,
      `border-left: ${px(6)}px solid var(--c-accent);`,
      "transform-origin: left center;",
      "transform: scaleX(0);",
    ]),
  ];
  const html = `<div class="lay lay-code"><div class="cd-win"><div class="cd-bar">${dots}</div><div class="cd-body">${lines.join("")}</div></div></div>`;
  return {
    html,
    css,
    motion: (w, t) => {
      rise(w, `${sel} .cd-win`, t.t0, px(40));
      const gap = Math.min(0.14, (t.budget * 0.6) / layout.lines.length);
      layout.lines.forEach((_, i) => {
        w.fromTo(
          `${sel} .cd-ln-${i}`,
          { clipPath: REVEAL_HIDDEN },
          { clipPath: REVEAL_SHOWN, duration: 0.4, ease: "power2.out" },
          sec(t.t0 + 0.3 + i * gap),
        );
      });
      if (layout.highlight !== undefined) {
        w.fromTo(
          `${sel} .cd-hl`,
          { scaleX: 0 },
          { scaleX: 1, duration: 0.5, ease: "power3.inOut" },
          sec(t.t0 + 0.4 + layout.lines.length * gap),
        );
        // A small nudge of the highlighted line once the bar lands: the eye goes there.
        w.fromTo(
          `${sel} .cd-ln-${layout.highlight} .cd-tx`,
          { x: 0 },
          { x: px(12), duration: 0.4, ease: "power2.out" },
          sec(t.t0 + 0.7 + layout.lines.length * gap),
        );
      }
    },
  };
}

function chips(kit: LayoutKit, layout: LayoutOf<"chips">): LayoutDevice {
  const { sel, px, colors } = kit;
  const n = layout.items.length;
  const width = Math.min(kit.width, px(1180));
  const srcW = Math.round(width * (kit.portrait ? 0.3 : 0.3));
  const chipW = Math.round(width * (kit.portrait ? 0.52 : 0.4));
  const chipX = width - chipW;
  const chipH = px(76);
  const gapY = px(22);
  const height = Math.max(px(180), n * chipH + (n - 1) * gapY);
  const top0 = Math.round((height - (n * chipH + (n - 1) * gapY)) / 2);
  const mid = Math.round(height / 2);
  const srcH = px(130);
  const bend = Math.round((chipX - srcW) / 2);
  const clipFrom = `inset(0% ${num(((width - srcW) / width) * 100)}% 0% 0%)`;
  const wires = layout.items.map((_, i) => {
    const cy = top0 + i * (chipH + gapY) + Math.round(chipH / 2);
    const d = `M${srcW} ${mid} C${srcW + bend} ${mid} ${chipX - bend} ${cy} ${chipX} ${cy}`;
    return `<svg class="ch-wire ch-wire-${i}" viewBox="0 0 ${width} ${height}" aria-hidden="true"><path d="${d}"/></svg>`;
  });
  const chipsHtml = layout.items.map((item, i) => {
    const top = top0 + i * (chipH + gapY);
    return `<div class="ch-chip ch-chip-${i}" style="top: ${top}px;"><i class="ch-dot"></i>${escapeHtml(item)}</div>`;
  });
  const css = [
    cssRule(`${sel} .lay-chips`, ["position: relative;", `width: ${width}px;`, `height: ${height}px;`]),
    cssRule(`${sel} .ch-src`, [
      ...panel(kit, 24),
      ...kit.font("heading", kit.portrait ? 36 : 38, 700),
      "position: absolute;",
      "left: 0;",
      `top: ${mid - Math.round(srcH / 2)}px;`,
      `width: ${srcW}px;`,
      `height: ${srcH}px;`,
      "display: grid;",
      "place-items: center;",
      "text-align: center;",
      `padding: 0 ${px(18)}px;`,
      `border-color: var(--c-accent);`,
      `border-width: ${px(3)}px;`,
      "color: var(--c-foreground);",
      "line-height: 1.2;",
    ]),
    cssRule(`${sel} .ch-wire`, [
      "position: absolute;",
      "inset: 0;",
      `width: ${width}px;`,
      `height: ${height}px;`,
      "overflow: visible;",
      `clip-path: ${clipFrom};`,
    ]),
    cssRule(`${sel} .ch-wire path`, [
      "fill: none;",
      `stroke: ${colors.accentInk};`,
      `stroke-width: ${Math.max(2, px(4))};`,
      "stroke-linecap: round;",
    ]),
    cssRule(`${sel} .ch-chip`, [
      ...panel(kit, 999),
      ...kit.font("body", kit.portrait ? 32 : 32, 600),
      "position: absolute;",
      `left: ${chipX}px;`,
      `width: ${chipW}px;`,
      `height: ${chipH}px;`,
      "display: flex;",
      "align-items: center;",
      `gap: ${px(16)}px;`,
      `padding: 0 ${px(26)}px;`,
      "white-space: nowrap;",
      "overflow: hidden;",
      "text-overflow: ellipsis;",
      "color: var(--c-foreground);",
      "opacity: 0;",
    ]),
    cssRule(`${sel} .ch-dot`, [
      "flex: 0 0 auto;",
      `width: ${px(16)}px;`,
      `height: ${px(16)}px;`,
      "border-radius: 50%;",
      "background: var(--c-accent);",
    ]),
  ];
  const html = `<div class="lay lay-chips">${wires.join("")}<div class="ch-src">${escapeHtml(layout.source)}</div>${chipsHtml.join("")}</div>`;
  return {
    html,
    css,
    motion: (w, t) => {
      w.fromTo(
        `${sel} .ch-src`,
        { opacity: 0, scale: 0.86 },
        { opacity: 1, scale: 1, duration: 0.5, ease: "back.out(1.6)" },
        sec(t.t0),
      );
      const gap = Math.min(0.16, (t.budget * 0.6) / n);
      layout.items.forEach((_, i) => {
        const at = t.t0 + 0.35 + i * gap;
        w.fromTo(
          `${sel} .ch-wire-${i}`,
          { clipPath: clipFrom },
          { clipPath: REVEAL_SHOWN, duration: 0.45, ease: "power2.inOut" },
          sec(at),
        );
        w.fromTo(
          `${sel} .ch-chip-${i}`,
          { opacity: 0, x: -px(24), scale: 0.9 },
          { opacity: 1, x: 0, scale: 1, duration: 0.45, ease: "back.out(1.7)" },
          sec(at + 0.3),
        );
      });
    },
  };
}

function checklist(kit: LayoutKit, layout: LayoutOf<"checklist">): LayoutDevice {
  const { sel, px, colors } = kit;
  const n = layout.items.length;
  const width = Math.min(kit.width, px(1000));
  const rowH = px(84);
  const gap = px(12);
  const box = px(46);
  const tick =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const rows = layout.items.map(
    (item, i) =>
      `<div class="ck-row ck-row-${i}" style="top: ${i * (rowH + gap)}px;"><span class="ck-box"><span class="ck-fill ck-fill-${i}"></span><span class="ck-tick ck-tick-${i}">${tick}</span></span><span class="ck-text">${escapeHtml(item.text)}</span>${
        item.status
          ? `<span class="ck-status"><span class="ck-pend ck-pend-${i}">…</span><span class="ck-st ck-st-${i}">${escapeHtml(item.status)}</span></span>`
          : ""
      }</div>`,
  );
  const css = [
    cssRule(`${sel} .lay-checklist`, [
      "position: relative;",
      `width: ${width}px;`,
      `height: ${n * rowH + (n - 1) * gap}px;`,
      "text-align: left;",
    ]),
    cssRule(`${sel} .ck-bar`, [
      "position: absolute;",
      "left: 0;",
      "top: 0;",
      "right: 0;",
      `height: ${rowH}px;`,
      `border-radius: ${px(20)}px;`,
      `background: ${colors.accentTint};`,
      "opacity: 0;",
    ]),
    cssRule(`${sel} .ck-row`, [
      "position: absolute;",
      "left: 0;",
      "right: 0;",
      `height: ${rowH}px;`,
      "display: flex;",
      "align-items: center;",
      `gap: ${px(24)}px;`,
      `padding: 0 ${px(24)}px;`,
      "box-sizing: border-box;",
      "opacity: 0;",
    ]),
    cssRule(`${sel} .ck-box`, [
      "position: relative;",
      "flex: 0 0 auto;",
      `width: ${box}px;`,
      `height: ${box}px;`,
      "border-radius: 50%;",
      `border: ${px(3)}px solid ${colors.line};`,
      "box-sizing: border-box;",
    ]),
    cssRule(`${sel} .ck-fill`, [
      "position: absolute;",
      `inset: ${-px(3)}px;`,
      "border-radius: 50%;",
      "background: var(--c-accent);",
      "opacity: 0;",
    ]),
    cssRule(`${sel} .ck-tick`, [
      "position: absolute;",
      "inset: 18%;",
      `color: ${colors.onAccent};`,
      `clip-path: ${REVEAL_HIDDEN};`,
    ]),
    cssRule(`${sel} .ck-tick svg`, ["display: block;", "width: 100%;", "height: 100%;"]),
    cssRule(`${sel} .ck-text`, [
      ...kit.font("body", 38, 600),
      "flex: 1 1 auto;",
      "white-space: nowrap;",
      "overflow: hidden;",
      "text-overflow: ellipsis;",
      "color: var(--c-foreground);",
    ]),
    cssRule(`${sel} .ck-status`, [
      ...kit.font("body", 28, 600),
      "position: relative;",
      "flex: 0 0 auto;",
      "display: grid;",
      `min-width: ${px(56)}px;`,
      "text-align: right;",
    ]),
    cssRule(`${sel} .ck-pend, ${sel} .ck-st`, ["grid-area: 1 / 1;"]),
    cssRule(`${sel} .ck-pend`, [`color: ${colors.muted};`]),
    cssRule(`${sel} .ck-st`, [`color: ${colors.accentInk};`, "opacity: 0;"]),
  ];
  const html = `<div class="lay lay-checklist"><div class="ck-bar"></div>${rows.join("")}</div>`;
  return {
    html,
    css,
    motion: (w, t) => {
      layout.items.forEach((_, i) => {
        rise(w, `${sel} .ck-row-${i}`, t.t0 + i * 0.08, px(24));
      });
      const first = t.t0 + 0.3 + n * 0.08;
      const step = Math.min(0.6, Math.max(0.25, (t.t0 + t.budget - first) / n));
      layout.items.forEach((item, i) => {
        const at = first + i * step;
        const y = i * (rowH + gap);
        if (i === 0) {
          w.fromTo(
            `${sel} .ck-bar`,
            { opacity: 0, y },
            { opacity: 1, y, duration: 0.25, ease: "power2.out" },
            sec(at),
          );
        } else {
          w.fromTo(
            `${sel} .ck-bar`,
            { y: y - rowH - gap },
            { y, duration: 0.3, ease: "power3.inOut" },
            sec(at - 0.05),
          );
        }
        w.fromTo(
          `${sel} .ck-fill-${i}`,
          { opacity: 0, scale: 0.4 },
          { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(2)" },
          sec(at + 0.1),
        );
        w.fromTo(
          `${sel} .ck-tick-${i}`,
          { clipPath: REVEAL_HIDDEN },
          { clipPath: REVEAL_SHOWN, duration: 0.25, ease: "power2.out" },
          sec(at + 0.2),
        );
        if (item.status) {
          w.fromTo(`${sel} .ck-pend-${i}`, { opacity: 1 }, { opacity: 0, duration: 0.15 }, sec(at + 0.2));
          w.fromTo(
            `${sel} .ck-st-${i}`,
            { opacity: 0, y: px(14) },
            { opacity: 1, y: 0, duration: 0.3, ease: "power3.out" },
            sec(at + 0.25),
          );
        }
      });
    },
  };
}

function counter(kit: LayoutKit, layout: LayoutOf<"counter">): LayoutDevice {
  const { sel, px, colors } = kit;
  const size = kit.portrait ? 190 : 210;
  const digits = [...layout.value];
  const cells = digits.map((ch, i) => {
    if (!/\d/.test(ch)) return `<span class="ct-sep">${escapeHtml(ch)}</span>`;
    // One full turn of the wheel, then on to the digit: 0-9, 0..d.
    const strip = [
      ...Array.from({ length: 10 }, (_, k) => k),
      ...Array.from({ length: Number(ch) + 1 }, (_, k) => k),
    ];
    return `<span class="ct-cell"><span class="ct-strip ct-strip-${i}">${strip.map((d) => `<span>${d}</span>`).join("")}</span></span>`;
  });
  const affix = (cls: string, text?: string) =>
    text ? `<span class="${cls}">${escapeHtml(text)}</span>` : "";
  const css = [
    cssRule(`${sel} .lay-counter`, [
      "display: flex;",
      "flex-direction: column;",
      "align-items: center;",
      `gap: ${px(22)}px;`,
    ]),
    cssRule(`${sel} .ct-num`, [
      ...kit.font("heading", size, 800),
      "display: flex;",
      "align-items: flex-start;",
      "line-height: 1.1;",
      "font-variant-numeric: tabular-nums;",
      "letter-spacing: -0.02em;",
      "color: var(--c-foreground);",
    ]),
    cssRule(`${sel} .ct-cell`, ["display: inline-block;", "height: 1.1em;", "overflow: hidden;"]),
    cssRule(`${sel} .ct-strip, ${sel} .ct-strip span`, ["display: block;", "height: 1.1em;"]),
    cssRule(`${sel} .ct-strip`, ["height: auto;"]),
    cssRule(`${sel} .ct-pre, ${sel} .ct-suf`, [`color: ${colors.accentInk};`]),
    cssRule(`${sel} .ct-track`, [
      `width: ${Math.min(kit.width, px(640))}px;`,
      `height: ${px(10)}px;`,
      "border-radius: 999px;",
      `background: ${colors.line};`,
      "overflow: hidden;",
    ]),
    cssRule(`${sel} .ct-fill`, [
      "display: block;",
      "height: 100%;",
      "background: var(--c-accent);",
      "transform-origin: left center;",
      "transform: scaleX(0);",
    ]),
    cssRule(`${sel} .ct-label`, [
      ...kit.font("body", 40, 500),
      `color: ${colors.muted};`,
      "text-align: center;",
    ]),
  ];
  const html = `<div class="lay lay-counter"><div class="ct-num">${affix("ct-pre", layout.prefix)}${cells.join("")}${affix("ct-suf", layout.suffix)}</div><div class="ct-track"><span class="ct-fill"></span></div>${affix("ct-label", layout.label)}</div>`;
  return {
    html,
    css,
    motion: (w, t) => {
      rise(w, `${sel} .ct-num`, t.t0, px(30));
      const roll = Math.min(1.8, Math.max(0.8, t.budget * 0.8));
      digits.forEach((ch, i) => {
        if (!/\d/.test(ch)) return;
        const len = 11 + Number(ch);
        // Leftmost digits settle last, like an odometer.
        w.fromTo(
          `${sel} .ct-strip-${i}`,
          { yPercent: 0 },
          { yPercent: -((len - 1) / len) * 100, duration: sec(roll - 0.04 * i), ease: "power4.out" },
          sec(t.t0 + 0.1 + 0.04 * i),
        );
      });
      w.fromTo(
        `${sel} .ct-fill`,
        { scaleX: 0 },
        { scaleX: 1, duration: sec(roll), ease: "power3.out" },
        sec(t.t0 + 0.1),
      );
      if (layout.suffix)
        w.fromTo(
          `${sel} .ct-suf`,
          { opacity: 0, scale: 0.5 },
          { opacity: 1, scale: 1, duration: 0.4, ease: "back.out(2.2)" },
          sec(t.t0 + roll * 0.7),
        );
      if (layout.label) rise(w, `${sel} .ct-label`, t.t0 + 0.3, px(18));
    },
  };
}

function cardsRow(kit: LayoutKit, layout: LayoutOf<"cards-row">): LayoutDevice {
  const { sel, px, colors } = kit;
  const n = layout.items.length;
  const hi = layout.highlight ?? n - 1;
  const column = kit.portrait;
  const gap = px(24);
  const width = Math.min(kit.width, px(1240));
  const cardW = column ? width : Math.floor((width - gap * (n - 1)) / n);
  const cards = layout.items.map(
    (item, i) =>
      `<div class="cr-card cr-card-${i}"><span class="cr-glow"></span><span class="cr-no">${String(i + 1).padStart(2, "0")}</span><span class="cr-label">${escapeHtml(item)}</span></div>`,
  );
  const css = [
    cssRule(`${sel} .lay-cards-row`, [
      "display: flex;",
      `flex-direction: ${column ? "column" : "row"};`,
      `gap: ${column ? px(18) : gap}px;`,
      `width: ${width}px;`,
    ]),
    cssRule(`${sel} .cr-card`, [
      ...panel(kit, 24),
      "position: relative;",
      `width: ${cardW}px;`,
      `height: ${column ? px(104) : px(n > 4 ? 250 : 270)}px;`,
      "display: flex;",
      `flex-direction: ${column ? "row" : "column"};`,
      `align-items: ${column ? "center" : "flex-start"};`,
      `justify-content: ${column ? "flex-start" : "space-between"};`,
      `gap: ${px(22)}px;`,
      `padding: ${px(26)}px;`,
      "text-align: left;",
      "opacity: 0;",
    ]),
    cssRule(`${sel} .cr-glow`, [
      "position: absolute;",
      `inset: ${-px(2)}px;`,
      `border-radius: ${px(24)}px;`,
      `border: ${px(4)}px solid var(--c-accent);`,
      `background: ${colors.accentTint};`,
      `box-shadow: 0 ${px(20)}px ${px(50)}px rgba(0, 0, 0, 0.3);`,
      "opacity: 0;",
    ]),
    cssRule(`${sel} .cr-no`, [
      ...kit.font("heading", 30, 800),
      "position: relative;",
      `color: ${colors.accentInk};`,
    ]),
    cssRule(`${sel} .cr-label`, [
      ...kit.font("heading", n > 4 && !column ? 30 : 34, 700),
      "position: relative;",
      "line-height: 1.25;",
      "color: var(--c-foreground);",
      "overflow-wrap: break-word;",
    ]),
  ];
  return {
    html: `<div class="lay lay-cards-row">${cards.join("")}</div>`,
    css,
    motion: (w, t) => {
      layout.items.forEach((_, i) => {
        w.fromTo(
          `${sel} .cr-card-${i}`,
          column ? { opacity: 0, x: -px(40) } : { opacity: 0, y: px(60), rotation: -2 },
          column
            ? { opacity: 1, x: 0, duration: 0.5, ease: "power3.out" }
            : { opacity: 1, y: 0, rotation: 0, duration: 0.55, ease: "power3.out" },
          sec(t.t0 + i * 0.09),
        );
      });
      const lift = t.t0 + Math.min(t.budget * 0.6, 0.45 + n * 0.09);
      const card = `${sel} .cr-card-${hi}`;
      w.fromTo(
        card,
        column ? { x: 0, scale: 1 } : { y: 0, scale: 1 },
        column
          ? { x: px(20), scale: 1.03, duration: 0.5, ease: "back.out(1.6)" }
          : { y: -px(28), scale: 1.06, duration: 0.5, ease: "back.out(1.6)" },
        sec(lift),
      );
      w.fromTo(
        `${card} .cr-glow`,
        { opacity: 0 },
        { opacity: 1, duration: 0.35, ease: "power2.out" },
        sec(lift),
      );
      layout.items.forEach((_, i) => {
        if (i === hi) return;
        w.fromTo(
          `${sel} .cr-card-${i}`,
          { opacity: 1 },
          { opacity: 0.5, duration: 0.4, ease: "power2.out" },
          sec(lift),
        );
      });
    },
  };
}

function swatches(kit: LayoutKit, layout: LayoutOf<"swatches">): LayoutDevice {
  const { sel, px, colors } = kit;
  const n = layout.colors.length;
  const d = px(kit.portrait ? 170 : n > 4 ? 160 : 190);
  const items = layout.colors.map((c, i) => {
    const hex = kit.hex(c.color);
    const fill = c.color.startsWith("#") ? c.color : `var(--c-${c.color})`;
    return `<div class="sw-item sw-item-${i}"><span class="sw-dot sw-dot-${i}" style="background: ${fill};"></span>${
      c.label ? `<span class="sw-label">${escapeHtml(c.label)}</span>` : ""
    }${hex ? `<span class="sw-hex">${escapeHtml(hex.toUpperCase())}</span>` : ""}</div>`;
  });
  const css = [
    cssRule(`${sel} .lay-swatches`, [
      "display: flex;",
      "flex-wrap: wrap;",
      "justify-content: center;",
      `gap: ${px(36)}px ${px(40)}px;`,
      `max-width: ${kit.portrait ? Math.min(kit.width, 3 * d + 2 * px(40)) : kit.width}px;`,
    ]),
    cssRule(`${sel} .sw-item`, [
      "display: flex;",
      "flex-direction: column;",
      "align-items: center;",
      `gap: ${px(10)}px;`,
    ]),
    cssRule(`${sel} .sw-dot`, [
      "display: block;",
      `width: ${d}px;`,
      `height: ${d}px;`,
      "border-radius: 50%;",
      `box-shadow: 0 0 0 ${px(4)}px ${colors.line}, 0 ${px(18)}px ${px(40)}px rgba(0, 0, 0, 0.25);`,
    ]),
    cssRule(`${sel} .sw-label`, [
      ...kit.font("heading", 30, 700),
      `margin-top: ${px(10)}px;`,
      "color: var(--c-foreground);",
    ]),
    cssRule(`${sel} .sw-hex`, [
      ...kit.font("body", 24, 500),
      `color: ${colors.muted};`,
      "letter-spacing: 0.04em;",
    ]),
    cssRule(`${sel} .sw-label, ${sel} .sw-hex`, ["opacity: 0;"]),
  ];
  return {
    html: `<div class="lay lay-swatches">${items.join("")}</div>`,
    css,
    motion: (w, t) => {
      const gap = Math.min(0.12, (t.budget * 0.6) / n);
      layout.colors.forEach((_, i) => {
        const at = t.t0 + i * gap;
        w.fromTo(
          `${sel} .sw-dot-${i}`,
          { opacity: 0, scale: 0 },
          { opacity: 1, scale: 1, duration: 0.55, ease: "back.out(1.8)" },
          sec(at),
        );
        w.fromTo(
          `${sel} .sw-item-${i} .sw-label, ${sel} .sw-item-${i} .sw-hex`,
          { opacity: 0, y: px(12) },
          { opacity: 1, y: 0, duration: 0.4, ease: "power3.out" },
          sec(at + 0.2),
        );
      });
    },
  };
}

function stat(kit: LayoutKit, layout: LayoutOf<"stat">): LayoutDevice {
  const { sel, px, colors } = kit;
  const css = [
    cssRule(`${sel} .lay-stat`, [
      "display: flex;",
      "flex-direction: column;",
      "align-items: center;",
      `gap: ${px(18)}px;`,
    ]),
    cssRule(`${sel} .st-value`, [
      ...kit.font("heading", kit.portrait ? 200 : 230, 800),
      "line-height: 1.1;",
      "letter-spacing: -0.03em;",
      `color: ${colors.accentInk};`,
      "white-space: nowrap;",
    ]),
    cssRule(`${sel} .st-bar`, [
      `width: ${px(220)}px;`,
      `height: ${px(10)}px;`,
      "border-radius: 999px;",
      "background: var(--c-accent);",
      "transform: scaleX(0);",
    ]),
    cssRule(`${sel} .st-label`, [
      ...kit.font("body", 42, 500),
      `color: ${colors.muted};`,
      "text-align: center;",
    ]),
  ];
  const label = layout.label ? `<div class="st-label">${escapeHtml(layout.label)}</div>` : "";
  return {
    html: `<div class="lay lay-stat"><div class="st-value">${escapeHtml(layout.value)}</div><div class="st-bar"></div>${label}</div>`,
    css,
    motion: (w, t) => {
      w.fromTo(
        `${sel} .st-value`,
        { opacity: 0, y: px(50), scale: 0.92, clipPath: "inset(100% 0% 0% 0%)" },
        { opacity: 1, y: 0, scale: 1, clipPath: "inset(0% 0% 0% 0%)", duration: 0.7, ease: "power4.out" },
        sec(t.t0),
      );
      w.fromTo(
        `${sel} .st-bar`,
        { scaleX: 0 },
        { scaleX: 1, duration: 0.5, ease: "power3.inOut" },
        sec(t.t0 + 0.35),
      );
      if (layout.label) rise(w, `${sel} .st-label`, t.t0 + 0.45, px(20));
    },
  };
}

/**
 * Headline plus device inside one inner wrapper. The shot root keeps the timeline's enter and exit
 * presets; the headline rises a beat ahead of the device (overlap), and the wrapper drifts slowly through
 * the hold so the card never sits dead still.
 */
export function writeLayoutHold(
  w: Parameters<LayoutDevice["motion"]>[0],
  kit: LayoutKit,
  t: LayoutTiming,
): void {
  w.fromTo(
    `${kit.sel} > .lay-inner > .t-main`,
    { y: kit.px(36) },
    { y: 0, duration: 0.7, ease: "power3.out" },
    t.start,
  );
  const drift = t.holdEnd - t.holdStart;
  if (drift > 0.4) {
    w.fromTo(
      `${kit.sel} > .lay-inner`,
      { y: 0, scale: 1 },
      { y: -kit.px(10), scale: 1.015, duration: sec(drift), ease: "sine.inOut" },
      t.holdStart,
    );
  }
}
