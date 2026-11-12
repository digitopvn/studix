import type { ColorRole, LayoutSpec } from "@studix/video-ir";
import { burnedCaptionBand, cssColor, frameScale, TEXT_STYLES, type TextStyleToken } from "./brand-tokens.ts";
import { cssRule, escapeHtml, seconds } from "./html-utils.ts";
import type { TimelineWriter } from "./scene-timeline.ts";
import type { ShotMarkup, ShotMarkupContext } from "./shot-markup.ts";

/**
 * Built-in layouts (`LayoutSpec`): typed content drawn as HTML and animated by the scene timeline. Every
 * colour is a palette role (stage CSS variable), so a brand kit or style profile restyles them all, and every
 * size scales with the short frame edge like the text styles do. Motion follows the timeline rules in
 * scene-timeline.ts: absolute positions, opacity, transforms and clip-path only.
 */

/** A tint of a palette role over the scene fill. */
const tint = (role: ColorRole, pct: number) => `color-mix(in srgb, var(--c-${role}) ${pct}%, transparent)`;

/** WCAG relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** The palette role (foreground or background) that reads best on an accent fill. */
function inkOnAccent(ctx: ShotMarkupContext): string {
  const p = ctx.palette;
  if (!p) return "var(--c-background)";
  return contrast(p.foreground, p.accent) > contrast(p.background, p.accent)
    ? "var(--c-foreground)"
    : "var(--c-background)";
}

/**
 * Factor (at most `factor`) that keeps one unbroken line of `chars` characters inside `width`, taking a
 * display glyph as about 0.62em wide.
 */
function fitFactor(
  ctx: ShotMarkupContext,
  token: TextStyleToken,
  factor: number,
  chars: number,
  width: number,
) {
  const fits = (width * 0.95) / (Math.max(1, chars) * 0.62 * token.sizeAt1080 * ctx.scale);
  return Math.min(factor, fits);
}

/** Font declarations of a text style token at this frame's scale, `factor` times its size. */
function fontCss(ctx: ShotMarkupContext, token: TextStyleToken, factor = 1, weight = token.weight): string[] {
  ctx.fontWeights[token.font].add(weight);
  return [
    `font-family: ${ctx.fontStacks[token.font]};`,
    `font-size: ${Math.round(token.sizeAt1080 * ctx.scale * factor)}px;`,
    `line-height: ${token.lineHeight};`,
    `font-weight: ${weight};`,
  ];
}

const px = (ctx: ShotMarkupContext, n: number) => `${Math.max(1, Math.round(n * ctx.scale))}px`;
/** Width the content area leaves inside the safe margin (see scene-composition.ts). */
const contentWidth = (ctx: ShotMarkupContext) =>
  ctx.frame.width - 2 * Math.round(0.07 * Math.min(ctx.frame.width, ctx.frame.height));
const portrait = (ctx: ShotMarkupContext) => ctx.frame.height > ctx.frame.width;
/** Wider than tall (16:9): a square frame is neither portrait nor landscape. */
const landscape = (frame: { width: number; height: number }) => frame.width > frame.height;
/**
 * Height a layout may take: what the content area leaves under a headline of up to two lines and above
 * the burned captions, so a tall layout never runs into either.
 */
const layoutHeight = (ctx: ShotMarkupContext) => {
  const { width, height } = ctx.frame;
  const short = Math.min(width, height);
  const safe = Math.round(0.07 * short);
  const gap = Math.round(0.03 * short);
  const captions = Math.max(0, burnedCaptionBand(ctx.frame) + gap - safe);
  const reserve = ctx.reserveTop ?? 0;
  if (!landscape(ctx.frame)) return (height - 2 * safe - captions - reserve) * (portrait(ctx) ? 0.7 : 0.55);
  // Landscape: the content area less a two-line display headline, the gaps around it and the band the
  // captions keep at the bottom (see scene-composition.ts).
  const headline =
    2 * TEXT_STYLES.display.sizeAt1080 * TEXT_STYLES.display.lineHeight * frameScale(ctx.frame);
  return height - 2 * safe - headline - 2 * gap - captions - reserve;
};

/** How much larger a layout is drawn in a landscape frame than its short edge alone would make it. */
const LANDSCAPE_LAYOUT_BOOST = 1.25;

/** The smallest chip label, as a factor of the body size: 26 px at 1080, 33 px on a 16:9 frame. */
const MIN_CHIP_FACTOR = 0.6;

/**
 * How a chips layout sits: side by side, each label sized to stay on one line of its track, or hung off a
 * spine when the labels would be set below `MIN_CHIP_FACTOR` side by side (and always for four or more
 * chips on a portrait frame). A landscape row never hangs: there its labels keep the floor size and wrap
 * between words. Shared by the markup and the motion, so both draw the same arrangement.
 */
function chipsPlan(items: readonly string[], frame: { width: number; height: number }) {
  const n = items.length;
  const scale = frameScale(frame) * (landscape(frame) ? LANDSCAPE_LAYOUT_BOOST : 1);
  const width = frame.width - 2 * Math.round(0.07 * Math.min(frame.width, frame.height));
  const track = (Math.round(width * 0.94) - (n - 1) * 20 * scale) / n - 2 * 33 * scale;
  const longest = Math.max(...items.map((l) => Array.from(l).length));
  const fit = (track * 0.95) / (longest * 0.6 * TEXT_STYLES.body.sizeAt1080 * scale);
  const factor = Math.max(MIN_CHIP_FACTOR, Math.min(n > 4 ? 0.75 : 0.9, fit));
  const column = (frame.height > frame.width && n > 3) || (!landscape(frame) && fit < MIN_CHIP_FACTOR);
  return { column, factor: column ? 1 : factor };
}

const CHECK_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const ARROW_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M12.5 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PLAY_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
const TOOL_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Words the product UI layouts draw themselves, in the IR language (English unless Vietnamese). */
const UI_WORDS = {
  en: { running: "Running", done: "Done", approve: "Approve", cap: "Cap" },
  vi: { running: "Đang chạy", done: "Hoàn tất", approve: "Duyệt", cap: "Giới hạn" },
} as const;
const uiWords = (language: string | undefined) =>
  language?.toLowerCase().startsWith("vi") ? UI_WORDS.vi : UI_WORDS.en;

/** Lines a text of `chars` characters wraps to in `widthPx` at `fontPx` (a body glyph is about 0.55em). */
const wrappedLines = (chars: number, widthPx: number, fontPx: number) =>
  Math.max(1, Math.ceil((chars * 0.55 * fontPx) / Math.max(1, widthPx)));

/** Decimal places a usage amount is shown with: those it is written with, at most two. */
function decimalsOf(value: number): number {
  const text = String(value);
  const dot = text.indexOf(".");
  return dot < 0 || text.includes("e") ? 0 : Math.min(2, text.length - dot - 1);
}

/** An amount with its digits grouped and the decimal mark the language writes. */
function formatAmount(n: number, decimals: number, language: string | undefined): string {
  const [whole = "0", frac] = n.toFixed(decimals).split(".");
  const vi = language?.toLowerCase().startsWith("vi");
  const grouped = groupDigits(Number(whole), language);
  return frac ? `${grouped}${vi ? "," : "."}${frac}` : grouped;
}

/** Steps a usage amount counts up in: each one a pre-set label, shown in turn as the meter fills. */
const USAGE_STEPS = 12;

/** How a pipeline sits: a row, or a column on a portrait frame with more than three stages. */
const pipelineColumn = (n: number, frame: { width: number; height: number }) =>
  frame.height > frame.width && n > 3;

/** The stage of a pipeline the light stops at: `active`, else the last one (every stage done). */
const pipelineReach = (layout: { items: readonly string[]; active?: number | undefined }) =>
  Math.min(layout.active ?? layout.items.length - 1, layout.items.length - 1);

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Up to `max` runs of the text's characters; a grapheme (an emoji, a stacked diacritic) stays whole. */
function typingChunks(text: string, max: number): string[] {
  const chars = Array.from(GRAPHEMES.segment(text.normalize("NFC")), (g) => g.segment);
  const size = Math.ceil(chars.length / max);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out;
}

const TYPING_STEPS = 40;

/** `code` source with quoted strings and trailing comments marked, escaped for HTML. */
function codeHtml(line: string): string {
  const comment = /(\s|^)(\/\/|#).*$/.exec(line);
  const body = comment ? line.slice(0, comment.index + (comment[1]?.length ?? 0)) : line;
  const tail = comment ? line.slice(body.length) : "";
  const parts = body.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/);
  const src = parts
    .map((p, i) => (i % 2 === 1 ? `<span class="lo-str">${escapeHtml(p)}</span>` : escapeHtml(p)))
    .join("");
  return tail ? `${src}<span class="lo-cmt">${escapeHtml(tail)}</span>` : src;
}

/** Digits of `n` grouped by thousands, with the separator the language writes. */
function groupDigits(n: number, language: string | undefined): string {
  const sep = language?.toLowerCase().startsWith("vi") ? "." : ",";
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

/** Digit strip of a counter column: three turns of 0-9, so low columns can spin past their target. */
const STRIP = "012345678901234567890123456789";

/** HTML and CSS for a layout shot; `sel` is the shot's outer element selector. */
export function renderLayoutMarkup(
  frameCtx: ShotMarkupContext,
  sel: string,
  open: string,
  base: string[],
  layout: LayoutSpec,
  ink: string,
): ShotMarkup {
  // Sizes scale with the short frame edge, so a landscape frame would draw a layout as small as a portrait one
  // in a frame almost twice as wide. There it is drawn larger (widths, heights and the type sized to fit them
  // are still capped by the content area), so the layout fills the card instead of floating in it.
  const ctx = landscape(frameCtx.frame)
    ? { ...frameCtx, scale: frameCtx.scale * LANDSCAPE_LAYOUT_BOOST }
    : frameCtx;
  const width = contentWidth(ctx);
  const css: string[] = [
    cssRule(sel, [...base, "display: flex;", "justify-content: center;", "max-width: 100%;"]),
    cssRule(`${sel} .lo`, [`color: ${ink};`, "box-sizing: border-box;", "max-width: 100%;"]),
  ];
  const rule = (s: string, decls: string[]) => css.push(cssRule(`${sel} ${s}`, decls));
  const body = TEXT_STYLES.body;
  const done = (html: string): ShotMarkup => ({ html: `${open}${html}</div>`, css });

  switch (layout.kind) {
    case "prompt-box": {
      rule(".lo-prompt", [
        "display: flex;",
        "align-items: center;",
        `gap: ${px(ctx, 22)};`,
        `width: ${Math.round(width * (portrait(ctx) ? 1 : 0.8))}px;`,
        `padding: ${px(ctx, 26)} ${px(ctx, 26)} ${px(ctx, 26)} ${px(ctx, 36)};`,
        `border: ${px(ctx, 3)} solid ${tint("foreground", 35)};`,
        `border-radius: ${px(ctx, 30)};`,
        `background: ${tint("foreground", 7)};`,
      ]);
      rule(".lo-field", [
        ...fontCss(ctx, body, 1.1),
        "flex: 1 1 auto;",
        "text-align: left;",
        "min-width: 0;",
      ]);
      rule(".lo-ch", ["opacity: 0;"]);
      rule(".lo-caret", [
        "display: inline-block;",
        "width: 0.08em;",
        "height: 1.1em;",
        "margin-left: 0.06em;",
        "vertical-align: text-bottom;",
        "background: var(--c-accent);",
        "opacity: 0;",
      ]);
      rule(".lo-send", [
        ...fontCss(ctx, TEXT_STYLES.caption, 1, 700),
        "flex: 0 0 auto;",
        `padding: ${px(ctx, 14)} ${px(ctx, 30)};`,
        "border-radius: 999px;",
        "background: var(--c-accent);",
        `color: ${inkOnAccent(ctx)};`,
        "white-space: nowrap;",
      ]);
      const chunks = typingChunks(layout.text, TYPING_STEPS)
        .map((c, i) => `<span class="lo-ch lo-c${i}">${escapeHtml(c)}</span>`)
        .join("");
      const send = layout.action ? `<div class="lo-send">${escapeHtml(layout.action)}</div>` : "";
      return done(
        `<div class="lo lo-prompt"><div class="lo-field">${chunks}<span class="lo-caret"></span></div>${send}</div>`,
      );
    }
    case "code": {
      const longest = Math.max(12, ...layout.lines.map((l) => l.length + 4));
      // Monospace glyphs are about 0.6em wide: shrink the type until the longest line fits the window, and
      // the lines fit the layout's height less the window's title bar and padding (about 110 px at 1080).
      const sizePx = Math.min(
        Math.round(TEXT_STYLES.body.sizeAt1080 * ctx.scale),
        Math.floor((width * 0.9) / (longest * 0.6)),
        Math.floor((layoutHeight(ctx) - 110 * ctx.scale) / (layout.lines.length * 1.55)),
      );
      ctx.fontWeights.mono.add(500);
      rule(".lo-code", [
        `width: ${Math.round(width * (portrait(ctx) ? 1 : 0.82))}px;`,
        `border: ${px(ctx, 2)} solid ${tint("foreground", 18)};`,
        `border-radius: ${px(ctx, 22)};`,
        `background: ${tint("foreground", 7)};`,
        "overflow: hidden;",
        "text-align: left;",
      ]);
      rule(".lo-bar", [
        "display: flex;",
        "align-items: center;",
        `gap: ${px(ctx, 12)};`,
        `padding: ${px(ctx, 16)} ${px(ctx, 24)};`,
        `border-bottom: ${px(ctx, 2)} solid ${tint("foreground", 12)};`,
        ...fontCss(ctx, TEXT_STYLES.caption, 0.8),
        "opacity: 0.7;",
      ]);
      rule(".lo-bar i", [
        `width: ${px(ctx, 16)};`,
        `height: ${px(ctx, 16)};`,
        "border-radius: 50%;",
        `background: ${tint("foreground", 30)};`,
      ]);
      rule(".lo-lines", [`padding: ${px(ctx, 18)} 0;`]);
      rule(".lo-line", [
        "position: relative;",
        "display: flex;",
        `font-family: ${ctx.fontStacks.mono};`,
        `font-size: ${sizePx}px;`,
        "line-height: 1.55;",
        "font-weight: 500;",
        "white-space: pre;",
        `padding: 0 ${px(ctx, 24)};`,
      ]);
      rule(".lo-hlbar", [
        "position: absolute;",
        "inset: 0;",
        `background: ${tint("accent", 22)};`,
        `border-left: ${px(ctx, 6)} solid var(--c-accent);`,
        "transform-origin: left center;",
      ]);
      rule(".lo-no", ["position: relative;", "opacity: 0.4;", "width: 2.6em;", "flex: 0 0 auto;"]);
      rule(".lo-src", ["position: relative;"]);
      rule(".lo-str", ["color: var(--c-accent);"]);
      rule(".lo-cmt", ["opacity: 0.55;"]);
      const marked = new Set(layout.highlight ?? []);
      const lines = layout.lines
        .map(
          (line, i) =>
            `<div class="lo-line lo-l${i}">${marked.has(i) ? '<span class="lo-hlbar"></span>' : ""}` +
            `<span class="lo-no">${i + 1}</span><span class="lo-src">${codeHtml(line)}</span></div>`,
        )
        .join("");
      const title = layout.title ? `<span>${escapeHtml(layout.title)}</span>` : "";
      return done(
        `<div class="lo lo-code"><div class="lo-bar"><i></i><i></i><i></i>${title}</div><div class="lo-lines">${lines}</div></div>`,
      );
    }
    case "chips": {
      const n = layout.items.length;
      const { column, factor: chipFactor } = chipsPlan(layout.items, frameCtx.frame);
      // A spine of chips is about 155 px (hub and stem) plus 94 px a chip and 18 px between at 1080: it
      // shrinks to the height the card leaves it, like a checklist.
      const k = column ? Math.min(1, layoutHeight(ctx) / ((155 + n * 94 + (n - 1) * 18) * ctx.scale)) : 1;
      const c = k < 1 ? { ...ctx, scale: ctx.scale * k } : ctx;
      const line = tint("foreground", 45);
      const stroke = px(c, 4);
      const pill = [
        `padding: ${px(c, 16)} ${px(c, 30)};`,
        "border-radius: 999px;",
        "text-align: center;",
        "overflow-wrap: anywhere;",
      ];
      rule(".lo-chips", [
        "display: flex;",
        "flex-direction: column;",
        column ? "align-items: flex-start;" : "align-items: center;",
        `width: ${Math.round(width * (column ? 0.86 : 0.94))}px;`,
      ]);
      rule(".lo-hub", [
        ...fontCss(c, body, 1.1, 700),
        ...pill,
        "background: var(--c-accent);",
        `color: ${inkOnAccent(c)};`,
      ]);
      rule(".lo-stem", [
        `width: ${stroke};`,
        `height: ${px(c, 56)};`,
        `background: ${line};`,
        "transform-origin: top center;",
        column ? `margin-left: ${px(c, 40)};` : "",
      ]);
      rule(".lo-row", [
        "position: relative;",
        "display: grid;",
        "width: 100%;",
        column ? "grid-auto-rows: 1fr;" : `grid-template-columns: repeat(${n}, minmax(0, 1fr));`,
        `gap: ${px(c, column ? 18 : 20)};`,
        column ? `padding-left: ${px(c, 40)};` : "",
        "box-sizing: border-box;",
      ]);
      // The bus runs between the first and last chip's centres, which equal tracks make exact.
      rule(
        ".lo-bus",
        column
          ? [
              "position: absolute;",
              `left: ${px(c, 40)};`,
              "top: 0;",
              `bottom: calc(100% / ${2 * n});`,
              `width: ${stroke};`,
              `background: ${line};`,
              "transform-origin: top center;",
            ]
          : [
              "position: absolute;",
              "top: 0;",
              `left: calc(100% / ${2 * n});`,
              `right: calc(100% / ${2 * n});`,
              `height: ${stroke};`,
              `background: ${line};`,
              "transform-origin: center;",
            ],
      );
      rule(".lo-item", [
        "display: flex;",
        column ? "flex-direction: row;" : "flex-direction: column;",
        "align-items: center;",
        "min-width: 0;",
      ]);
      rule(
        ".lo-drop",
        column
          ? [
              `width: ${px(c, 36)};`,
              `height: ${stroke};`,
              `background: ${line};`,
              "flex: 0 0 auto;",
              "transform-origin: left center;",
            ]
          : [
              `width: ${stroke};`,
              `height: ${px(c, 44)};`,
              `background: ${line};`,
              "transform-origin: top center;",
            ],
      );
      rule(".lo-chip", [
        ...fontCss(c, body, chipFactor, 600),
        ...pill,
        `border: ${px(c, 3)} solid ${tint("foreground", 40)};`,
        `background: ${tint("foreground", 7)};`,
        "min-width: 0;",
      ]);
      const items = layout.items
        .map(
          (label, i) =>
            `<div class="lo-item lo-i${i}"><div class="lo-drop"></div><div class="lo-chip">${escapeHtml(label)}</div></div>`,
        )
        .join("");
      return done(
        `<div class="lo lo-chips"><div class="lo-hub">${escapeHtml(layout.hub)}</div><div class="lo-stem"></div><div class="lo-row"><div class="lo-bus"></div>${items}</div></div>`,
      );
    }
    case "checklist": {
      const n = layout.items.length;
      // A step is about 100px tall at 1080 (mark plus padding), 22px apart: shrink to fit the height.
      const k = Math.min(1, layoutHeight(ctx) / ((n * 100 + (n - 1) * 22) * ctx.scale));
      const sz = (v: number) => px(ctx, v * k);
      const mark = sz(64);
      rule(".lo-checklist", [
        "display: grid;",
        `gap: ${sz(22)};`,
        `width: ${Math.round(width * (portrait(ctx) ? 0.94 : 0.7))}px;`,
        "text-align: left;",
      ]);
      rule(".lo-step", [
        "display: flex;",
        "align-items: center;",
        `gap: ${sz(26)};`,
        `padding: ${sz(18)} ${sz(26)};`,
        `border-radius: ${sz(20)};`,
        `background: ${tint("foreground", 6)};`,
      ]);
      rule(".lo-active", [`box-shadow: inset 0 0 0 ${sz(3)} var(--c-accent);`]);
      rule(".lo-todo .lo-label", ["opacity: 0.6;"]);
      rule(".lo-mark", [
        "position: relative;",
        "flex: 0 0 auto;",
        `width: ${mark};`,
        `height: ${mark};`,
        "border-radius: 50%;",
        `border: ${sz(4)} solid ${tint("foreground", 35)};`,
        "box-sizing: border-box;",
      ]);
      rule(".lo-done .lo-mark", ["border-color: var(--c-accent);"]);
      rule(".lo-active .lo-mark", ["border-color: var(--c-accent);"]);
      rule(".lo-tick", [
        "position: absolute;",
        `inset: -${sz(4)};`,
        "border-radius: 50%;",
        "background: var(--c-accent);",
        `color: ${inkOnAccent(ctx)};`,
        "display: grid;",
        "place-items: center;",
      ]);
      rule(".lo-tick svg", ["width: 62%;", "height: 62%;"]);
      rule(".lo-dot", [
        "position: absolute;",
        "inset: 26%;",
        "border-radius: 50%;",
        "background: var(--c-accent);",
      ]);
      rule(".lo-label", [...fontCss(ctx, body, 1.05 * k, 600), "min-width: 0;"]);
      const steps = layout.items
        .map((item, i) => {
          const inner =
            item.state === "done"
              ? `<span class="lo-tick">${CHECK_SVG}</span>`
              : item.state === "active"
                ? '<span class="lo-dot"></span>'
                : "";
          return `<div class="lo-step lo-s${i} lo-${item.state}"><span class="lo-mark">${inner}</span><span class="lo-label">${escapeHtml(item.label)}</span></div>`;
        })
        .join("");
      return done(`<div class="lo lo-checklist">${steps}</div>`);
    }
    case "counter": {
      const target = groupDigits(layout.to, ctx.language);
      rule(".lo-counter", ["display: flex;", "flex-direction: column;", "align-items: center;"]);
      const chars = target.length + (layout.prefix?.length ?? 0) + (layout.suffix?.length ?? 0);
      rule(".lo-num", [
        ...fontCss(ctx, TEXT_STYLES.display, fitFactor(ctx, TEXT_STYLES.display, 1.5, chars, width)),
        "line-height: 1.15;",
        "display: flex;",
        "align-items: flex-end;",
        "font-variant-numeric: tabular-nums;",
        "white-space: nowrap;",
      ]);
      rule(".lo-dg", [
        "display: inline-block;",
        "height: 1.15em;",
        "overflow: hidden;",
        "vertical-align: bottom;",
      ]);
      rule(".lo-strip", ["display: flex;", "flex-direction: column;"]);
      rule(".lo-strip span", ["height: 1.15em;", "text-align: center;"]);
      rule(".lo-affix", ["color: var(--c-accent);"]);
      rule(".lo-clabel", [...fontCss(ctx, body, 1.05, 500), "opacity: 0.75;", `margin-top: ${px(ctx, 8)};`]);
      const strip = Array.from(STRIP, (d) => `<span>${d}</span>`).join("");
      // A separator belongs to the digit before it, so it shows and hides with that digit.
      let col = 0;
      const digits = Array.from(target)
        .map((c) =>
          /\d/.test(c)
            ? `<span class="lo-dg lo-g${col}"><span class="lo-strip lo-d${col++}">${strip}</span></span>`
            : `<span class="lo-p${col - 1}">${escapeHtml(c)}</span>`,
        )
        .join("");
      const prefix = layout.prefix ? `<span class="lo-affix">${escapeHtml(layout.prefix)}</span>` : "";
      const suffix = layout.suffix ? `<span class="lo-affix">&#8202;${escapeHtml(layout.suffix)}</span>` : "";
      const label = layout.label ? `<div class="lo-clabel">${escapeHtml(layout.label)}</div>` : "";
      return done(
        `<div class="lo lo-counter"><div class="lo-num">${prefix}${digits}${suffix}</div>${label}</div>`,
      );
    }
    case "cards-row": {
      const n = layout.items.length;
      const cols = portrait(ctx) && n > 3 ? 2 : n;
      rule(".lo-cards", [
        "display: grid;",
        `grid-template-columns: repeat(${cols}, minmax(0, 1fr));`,
        `gap: ${px(ctx, 24)};`,
        `width: ${Math.round(width * 0.96)}px;`,
        "align-items: stretch;",
      ]);
      rule(".lo-card", [
        "display: flex;",
        "flex-direction: column;",
        "justify-content: space-between;",
        `gap: ${px(ctx, 20)};`,
        `min-height: ${px(ctx, portrait(ctx) ? 200 : 260)};`,
        `padding: ${px(ctx, 26)};`,
        `border-radius: ${px(ctx, 24)};`,
        `border: ${px(ctx, 3)} solid ${tint("foreground", 16)};`,
        `background: ${tint("foreground", 7)};`,
        "text-align: left;",
        "box-sizing: border-box;",
      ]);
      rule(".lo-hot", ["border-color: var(--c-accent);", `background: ${tint("accent", 16)};`]);
      rule(".lo-idx", [...fontCss(ctx, TEXT_STYLES.caption, 0.9, 700), "color: var(--c-accent);"]);
      // A word breaks only when it cannot fit its card at all: the type shrinks to fit the longest word first.
      const inner =
        (Math.round(width * 0.96) - (cols - 1) * 24 * ctx.scale) / cols - 2 * (26 + 3) * ctx.scale;
      const word = Math.max(...layout.items.flatMap((l) => l.split(/\s+/).map((w) => Array.from(w).length)));
      const cardFactor = Math.min(
        n > 3 ? 0.85 : 1,
        (inner * 0.95) / (word * 0.62 * body.sizeAt1080 * ctx.scale),
      );
      rule(".lo-ctext", [...fontCss(ctx, body, cardFactor, 700), "overflow-wrap: anywhere;"]);
      const cards = layout.items
        .map(
          (label, i) =>
            `<div class="lo-card lo-k${i}${layout.highlight === i ? " lo-hot" : ""}"><span class="lo-idx">${String(i + 1).padStart(2, "0")}</span><span class="lo-ctext">${escapeHtml(label)}</span></div>`,
        )
        .join("");
      return done(`<div class="lo lo-cards">${cards}</div>`);
    }
    case "swatches": {
      const n = layout.items.length;
      const cols = portrait(ctx) && n > 3 ? 3 : n;
      const size = Math.min(Math.round(220 * ctx.scale), Math.floor((width * 0.9) / cols - 24 * ctx.scale));
      rule(".lo-swatches", [
        "display: grid;",
        `grid-template-columns: repeat(${cols}, auto);`,
        `gap: ${px(ctx, 28)} ${px(ctx, 36)};`,
        "justify-content: center;",
      ]);
      rule(".lo-sw", [
        "display: flex;",
        "flex-direction: column;",
        "align-items: center;",
        `gap: ${px(ctx, 14)};`,
      ]);
      rule(".lo-chipc", [
        `width: ${size}px;`,
        `height: ${size}px;`,
        `border-radius: ${px(ctx, 28)};`,
        `box-shadow: inset 0 0 0 ${px(ctx, 3)} ${tint("foreground", 22)};`,
      ]);
      rule(".lo-swl", [...fontCss(ctx, TEXT_STYLES.caption, 0.9, 600), "text-align: center;"]);
      const swatches = layout.items
        .map(
          (s, i) =>
            `<div class="lo-sw lo-w${i}"><div class="lo-chipc" style="background: ${cssColor(s.color)};"></div>${s.label ? `<div class="lo-swl">${escapeHtml(s.label)}</div>` : ""}</div>`,
        )
        .join("");
      return done(`<div class="lo lo-swatches">${swatches}</div>`);
    }
    case "stat": {
      rule(".lo-stat", ["display: flex;", "flex-direction: column;", "align-items: center;"]);
      rule(".lo-value", [
        ...fontCss(
          ctx,
          TEXT_STYLES.display,
          fitFactor(ctx, TEXT_STYLES.display, 1.6, layout.value.length, width),
        ),
        "line-height: 1.1;",
        "white-space: nowrap;",
      ]);
      rule(".lo-rule", [
        `width: ${px(ctx, 160)};`,
        `height: ${px(ctx, 10)};`,
        "border-radius: 999px;",
        "background: var(--c-accent);",
        `margin: ${px(ctx, 18)} 0 ${px(ctx, 22)};`,
        "transform-origin: center;",
      ]);
      rule(".lo-slabel", [...fontCss(ctx, body, 1.1, 500), "text-align: center;", "opacity: 0.85;"]);
      return done(
        `<div class="lo lo-stat"><div class="lo-value">${escapeHtml(layout.value)}</div><div class="lo-rule"></div><div class="lo-slabel">${escapeHtml(layout.label)}</div></div>`,
      );
    }
    case "chat": {
      const w = Math.round(width * (portrait(ctx) ? 1 : 0.8));
      // Height at full size: title bar, the sent bubble, the reply and the input (which wraps like the
      // bubble), each line about 1.4 of the 0.9-body type; shrink everything until it fits.
      const fontAt = (c: ShotMarkupContext) => body.sizeAt1080 * 0.9 * c.scale;
      const bubbleW = (w - 2 * 28 * ctx.scale) * 0.82 - 2 * 26 * ctx.scale;
      const linesOf = (text: string | undefined) =>
        text ? wrappedLines(Array.from(text).length, bubbleW, fontAt(ctx)) : 0;
      // The prompt shows twice: wrapped in the input as it is typed, then as the sent bubble.
      const textH = (linesOf(layout.prompt) * 2 + linesOf(layout.reply)) * fontAt(ctx) * 1.4;
      // Title bar 64, thread padding 48, bubble padding 36 each and 18 between, input margin and padding 54.
      const chrome = (64 + 48 + (layout.reply ? 2 * 36 + 18 : 36) + 54) * ctx.scale;
      const k = Math.min(1, layoutHeight(ctx) / (textH + chrome));
      const c = k < 1 ? { ...ctx, scale: ctx.scale * k } : ctx;
      rule(".lo-chat", [
        `width: ${w}px;`,
        `border: ${px(c, 2)} solid ${tint("foreground", 18)};`,
        `border-radius: ${px(c, 26)};`,
        `background: ${tint("foreground", 5)};`,
        "overflow: hidden;",
        "text-align: left;",
      ]);
      rule(".lo-cbar", [
        "display: flex;",
        "align-items: center;",
        `gap: ${px(c, 12)};`,
        `height: ${px(c, 64)};`,
        `padding: 0 ${px(c, 24)};`,
        "box-sizing: border-box;",
        `border-bottom: ${px(c, 2)} solid ${tint("foreground", 12)};`,
        ...fontCss(c, TEXT_STYLES.caption, 0.8, 600),
      ]);
      rule(".lo-cbar i", [
        `width: ${px(c, 16)};`,
        `height: ${px(c, 16)};`,
        "border-radius: 50%;",
        `background: ${tint("foreground", 30)};`,
      ]);
      rule(".lo-cbar span", [`margin-left: ${px(c, 8)};`, "opacity: 0.75;"]);
      rule(".lo-thread", [
        "display: flex;",
        "flex-direction: column;",
        `gap: ${px(c, 18)};`,
        `padding: ${px(c, 24)} ${px(c, 28)};`,
      ]);
      const bubble = [
        ...fontCss(c, body, 0.9, 500),
        "max-width: 82%;",
        `padding: ${px(c, 18)} ${px(c, 26)};`,
        "box-sizing: border-box;",
        "overflow-wrap: anywhere;",
        "opacity: 0;",
      ];
      rule(".lo-me", [
        ...bubble,
        "align-self: flex-end;",
        "background: var(--c-accent);",
        `color: ${inkOnAccent(c)};`,
        `border-radius: ${px(c, 26)} ${px(c, 26)} ${px(c, 8)} ${px(c, 26)};`,
      ]);
      rule(".lo-bot", ["display: grid;", "align-self: stretch;", "justify-items: start;"]);
      rule(".lo-bot > *", ["grid-area: 1 / 1;"]);
      rule(".lo-ai", [
        ...bubble,
        `background: ${tint("foreground", 10)};`,
        `border-radius: ${px(c, 26)} ${px(c, 26)} ${px(c, 26)} ${px(c, 8)};`,
      ]);
      rule(".lo-dots", [
        "display: flex;",
        `gap: ${px(c, 10)};`,
        `padding: ${px(c, 24)} ${px(c, 26)};`,
        `border-radius: ${px(c, 26)};`,
        `background: ${tint("foreground", 10)};`,
        "opacity: 0;",
      ]);
      rule(".lo-dots i", [
        `width: ${px(c, 14)};`,
        `height: ${px(c, 14)};`,
        "border-radius: 50%;",
        "background: currentColor;",
        "opacity: 0.6;",
      ]);
      rule(".lo-cin", [
        "display: flex;",
        "align-items: center;",
        `gap: ${px(c, 18)};`,
        `margin: 0 ${px(c, 22)} ${px(c, 22)};`,
        `padding: ${px(c, 14)} ${px(c, 14)} ${px(c, 14)} ${px(c, 26)};`,
        `border: ${px(c, 2)} solid ${tint("foreground", 30)};`,
        `border-radius: ${px(c, 22)};`,
      ]);
      rule(".lo-field", [
        ...fontCss(c, body, 0.9),
        "flex: 1 1 auto;",
        "min-width: 0;",
        "overflow-wrap: anywhere;",
      ]);
      rule(".lo-ch", ["opacity: 0;"]);
      rule(".lo-caret", [
        "display: inline-block;",
        "width: 0.08em;",
        "height: 1.1em;",
        "margin-left: 0.06em;",
        "vertical-align: text-bottom;",
        "background: var(--c-accent);",
        "opacity: 0;",
      ]);
      rule(".lo-go", [
        "flex: 0 0 auto;",
        "display: grid;",
        "place-items: center;",
        `width: ${px(c, 60)};`,
        `height: ${px(c, 60)};`,
        "border-radius: 50%;",
        "background: var(--c-accent);",
        `color: ${inkOnAccent(c)};`,
      ]);
      rule(".lo-go svg", ["width: 55%;", "height: 55%;"]);
      const chunks = typingChunks(layout.prompt, TYPING_STEPS)
        .map((ch, i) => `<span class="lo-ch lo-c${i}">${escapeHtml(ch)}</span>`)
        .join("");
      const title = layout.title ? `<span>${escapeHtml(layout.title)}</span>` : "";
      const reply = layout.reply
        ? `<div class="lo-bot"><span class="lo-dots"><i class="lo-dt0"></i><i class="lo-dt1"></i><i class="lo-dt2"></i></span><div class="lo-ai">${escapeHtml(layout.reply)}</div></div>`
        : "";
      return done(
        `<div class="lo lo-chat"><div class="lo-cbar"><i></i><i></i><i></i>${title}</div>` +
          `<div class="lo-thread"><div class="lo-me">${escapeHtml(layout.prompt)}</div>${reply}</div>` +
          `<div class="lo-cin"><div class="lo-field"><span class="lo-typed">${chunks}</span><span class="lo-caret"></span></div><div class="lo-go">${ARROW_SVG}</div></div></div>`,
      );
    }
    case "tool-call": {
      const words = uiWords(ctx.language);
      const args = layout.args ?? [];
      const w = Math.round(width * (portrait(ctx) ? 1 : 0.78));
      // Head, one row an argument and the result line at full size (1080): shrink until they fit.
      const k = Math.min(
        1,
        layoutHeight(ctx) / ((120 + args.length * 64 + 40 + (layout.result ? 84 : 0)) * ctx.scale),
      );
      const c = k < 1 ? { ...ctx, scale: ctx.scale * k } : ctx;
      const monoPx = (factor: number, chars: number, room: number) =>
        Math.min(
          Math.round(body.sizeAt1080 * c.scale * factor),
          Math.floor(room / (Math.max(1, chars) * 0.6)),
        );
      const inner = w - 2 * 30 * c.scale;
      const nameChars = Array.from(layout.name).length + 2;
      const statusW = 260 * c.scale;
      const namePx = monoPx(1, nameChars, inner - 64 * c.scale - statusW);
      const argChars = Math.max(1, ...args.map((a) => Array.from(`${a.key}: "${a.value}"`).length));
      const argPx = monoPx(0.8, argChars, inner - 40 * c.scale);
      c.fontWeights.mono.add(600);
      rule(".lo-tool", [
        `width: ${w}px;`,
        `border: ${px(c, 2)} solid ${tint("foreground", 18)};`,
        `border-radius: ${px(c, 24)};`,
        `background: ${tint("foreground", 6)};`,
        "overflow: hidden;",
        "text-align: left;",
      ]);
      rule(".lo-thead", [
        "display: flex;",
        "align-items: center;",
        `gap: ${px(c, 18)};`,
        `padding: ${px(c, 24)} ${px(c, 30)};`,
        args.length || layout.result ? `border-bottom: ${px(c, 2)} solid ${tint("foreground", 12)};` : "",
      ]);
      rule(".lo-tglyph", [
        "flex: 0 0 auto;",
        "display: grid;",
        "place-items: center;",
        `width: ${px(c, 52)};`,
        `height: ${px(c, 52)};`,
        `border-radius: ${px(c, 14)};`,
        `background: ${tint("accent", 20)};`,
        "color: var(--c-accent);",
      ]);
      rule(".lo-tglyph svg", ["width: 62%;", "height: 62%;"]);
      rule(".lo-tname", [
        `font-family: ${c.fontStacks.mono};`,
        `font-size: ${namePx}px;`,
        "font-weight: 600;",
        "line-height: 1.3;",
        "flex: 1 1 auto;",
        "min-width: 0;",
        "overflow-wrap: anywhere;",
      ]);
      rule(".lo-tstat", ["display: grid;", "flex: 0 0 auto;", "justify-items: end;"]);
      rule(".lo-tstat > *", [
        "grid-area: 1 / 1;",
        "display: flex;",
        "align-items: center;",
        `gap: ${px(c, 12)};`,
        `padding: ${px(c, 10)} ${px(c, 20)};`,
        "border-radius: 999px;",
        ...fontCss(c, TEXT_STYLES.caption, 0.85, 600),
        "white-space: nowrap;",
      ]);
      rule(".lo-trun", [`background: ${tint("foreground", 10)};`]);
      rule(".lo-tok", [`background: ${tint("accent", 22)};`, "opacity: 0;"]);
      rule(".lo-spin", [
        "display: block;",
        `width: ${px(c, 26)};`,
        `height: ${px(c, 26)};`,
        "border-radius: 50%;",
        "box-sizing: border-box;",
        `border: ${px(c, 4)} solid ${tint("foreground", 25)};`,
        "border-top-color: var(--c-accent);",
      ]);
      rule(".lo-tick", [
        "display: grid;",
        "place-items: center;",
        `width: ${px(c, 30)};`,
        `height: ${px(c, 30)};`,
        "border-radius: 50%;",
        "background: var(--c-accent);",
        `color: ${inkOnAccent(c)};`,
      ]);
      rule(".lo-tick svg", ["width: 70%;", "height: 70%;"]);
      rule(".lo-targs", [`padding: ${px(c, 18)} ${px(c, 30)};`, "display: grid;", `gap: ${px(c, 8)};`]);
      rule(".lo-arg", [
        `font-family: ${c.fontStacks.mono};`,
        `font-size: ${argPx}px;`,
        "line-height: 1.5;",
        "font-weight: 500;",
        "overflow-wrap: anywhere;",
      ]);
      rule(".lo-k", ["opacity: 0.6;"]);
      rule(".lo-v", ["color: var(--c-accent);"]);
      rule(".lo-tres", [
        ...fontCss(c, body, 0.85, 600),
        "display: flex;",
        `gap: ${px(c, 14)};`,
        `padding: ${px(c, 18)} ${px(c, 30)} ${px(c, 22)};`,
        `border-top: ${px(c, 2)} solid ${tint("foreground", 12)};`,
        "opacity: 0;",
      ]);
      rule(".lo-tres i", ["font-style: normal;", "color: var(--c-accent);"]);
      const rows = args
        .map(
          (a, i) =>
            `<div class="lo-arg lo-a${i}"><span class="lo-k">${escapeHtml(a.key)}: </span><span class="lo-v">"${escapeHtml(a.value)}"</span></div>`,
        )
        .join("");
      const result =
        layout.result && layout.status === "done"
          ? `<div class="lo-tres"><i>&#8594;</i><span>${escapeHtml(layout.result)}</span></div>`
          : "";
      return done(
        `<div class="lo lo-tool"><div class="lo-thead"><span class="lo-tglyph">${TOOL_SVG}</span><span class="lo-tname">${escapeHtml(layout.name)}</span>` +
          `<span class="lo-tstat"><span class="lo-trun"><span class="lo-spin"></span>${escapeHtml(words.running)}</span><span class="lo-tok"><span class="lo-tick">${CHECK_SVG}</span>${escapeHtml(words.done)}</span></span></div>` +
          `${rows ? `<div class="lo-targs">${rows}</div>` : ""}${result}</div>`,
      );
    }
    case "pipeline": {
      const n = layout.items.length;
      const column = pipelineColumn(n, ctx.frame);
      // A column stage is about 120 px tall at 1080 (mark and gap): shrink the column to the height it has.
      const k = column ? Math.min(1, layoutHeight(ctx) / (n * 120 * ctx.scale)) : 1;
      const c = k < 1 ? { ...ctx, scale: ctx.scale * k } : ctx;
      const w = Math.round(width * (column ? 0.8 : 0.96));
      const mark = Math.max(1, Math.round(72 * c.scale));
      const stroke = px(c, 6);
      const word = Math.max(...layout.items.flatMap((l) => l.split(/\s+/).map((x) => Array.from(x).length)));
      const room = column ? w - mark - 28 * c.scale : w / n - 12 * c.scale;
      const factor = Math.min(column ? 0.95 : 0.8, (room * 0.95) / (word * 0.62 * body.sizeAt1080 * c.scale));
      rule(".lo-pipe", [
        "position: relative;",
        "display: grid;",
        `width: ${w}px;`,
        column
          ? `grid-auto-rows: ${Math.round(120 * c.scale)}px;`
          : `grid-template-columns: repeat(${n}, minmax(0, 1fr));`,
      ]);
      rule(
        ".lo-ptrack",
        column
          ? [
              "position: absolute;",
              `left: calc(${Math.round(mark / 2)}px - ${stroke} / 2);`,
              `top: calc(100% / ${2 * n});`,
              `bottom: calc(100% / ${2 * n});`,
              `width: ${stroke};`,
              `background: ${tint("foreground", 18)};`,
            ]
          : [
              "position: absolute;",
              `top: calc(${Math.round(mark / 2)}px - ${stroke} / 2);`,
              `left: calc(100% / ${2 * n});`,
              `right: calc(100% / ${2 * n});`,
              `height: ${stroke};`,
              `background: ${tint("foreground", 18)};`,
            ],
      );
      rule(".lo-pfill", [
        "position: absolute;",
        "inset: 0;",
        "background: var(--c-accent);",
        column ? "transform-origin: top center;" : "transform-origin: left center;",
      ]);
      rule(".lo-pnode", [
        "position: relative;",
        "display: flex;",
        column ? "flex-direction: row;" : "flex-direction: column;",
        "align-items: center;",
        `gap: ${px(c, column ? 28 : 18)};`,
        "min-width: 0;",
      ]);
      rule(".lo-pmark", [
        "position: relative;",
        "flex: 0 0 auto;",
        `width: ${mark}px;`,
        `height: ${mark}px;`,
        "border-radius: 50%;",
        "box-sizing: border-box;",
        `border: ${px(c, 4)} solid ${tint("foreground", 35)};`,
        "background: var(--c-background);",
      ]);
      rule(".lo-pmark > span", ["position: absolute;", "border-radius: 50%;", "opacity: 0;"]);
      rule(".lo-ptick", [
        `inset: -${px(c, 4)};`,
        "background: var(--c-accent);",
        `color: ${inkOnAccent(c)};`,
        "display: grid;",
        "place-items: center;",
      ]);
      rule(".lo-ptick svg", ["width: 60%;", "height: 60%;"]);
      rule(".lo-pring", [`inset: -${px(c, 4)};`, `border: ${px(c, 4)} solid var(--c-accent);`]);
      rule(".lo-pdot", ["inset: 26%;", "background: var(--c-accent);"]);
      rule(".lo-plabel", [
        ...fontCss(c, body, factor, 600),
        column ? "text-align: left;" : "text-align: center;",
        "opacity: 0.55;",
        "min-width: 0;",
      ]);
      const reach = pipelineReach(layout);
      const nodes = layout.items
        .map((label, i) => {
          const inner =
            i < reach || (i === reach && layout.active === undefined)
              ? `<span class="lo-ptick">${CHECK_SVG}</span>`
              : i === reach
                ? '<span class="lo-pring"></span><span class="lo-pdot"></span>'
                : "";
          return `<div class="lo-pnode lo-n${i}"><span class="lo-pmark">${inner}</span><span class="lo-plabel">${escapeHtml(label)}</span></div>`;
        })
        .join("");
      return done(
        `<div class="lo lo-pipe"><div class="lo-ptrack"><div class="lo-pfill"></div></div>${nodes}</div>`,
      );
    }
    case "player": {
      const words = uiWords(ctx.language);
      // The screen is 16:9; the controls and the button below it take about 200 px at 1080. A landscape frame
      // is short and wide: there the button stands beside the screen, so the screen keeps the height.
      const side = landscape(ctx.frame);
      const actionLabel = layout.action ?? words.approve;
      const approveW = Math.round(
        (Array.from(actionLabel).length * 0.62 * 0.95 * body.sizeAt1080 + 130) * ctx.scale,
      );
      const below = (side ? 60 : 200) * ctx.scale;
      const room = side ? width * 0.95 - approveW - 40 * ctx.scale : width * (portrait(ctx) ? 1 : 0.72);
      const w = Math.round(Math.min(room, ((layoutHeight(ctx) - below) * 16) / 9));
      const h = Math.round((w * 9) / 16);
      const btn = Math.round(40 * ctx.scale);
      const gap = Math.round(18 * ctx.scale);
      const bar = Math.max(1, w - btn - gap);
      const knob = Math.max(2, Math.round(22 * ctx.scale));
      rule(".lo-player", [
        "display: flex;",
        side ? "flex-direction: row;" : "flex-direction: column;",
        "align-items: center;",
        `gap: ${px(ctx, side ? 40 : 22)};`,
      ]);
      rule(".lo-pmain", ["display: flex;", "flex-direction: column;", `gap: ${px(ctx, 18)};`]);
      rule(".lo-screen", [
        "position: relative;",
        `width: ${w}px;`,
        `height: ${h}px;`,
        `border-radius: ${px(ctx, 24)};`,
        "overflow: hidden;",
        `background: ${tint("foreground", 8)};`,
        `box-shadow: inset 0 0 0 ${px(ctx, 2)} ${tint("foreground", 16)};`,
      ]);
      rule(".lo-art i", ["position: absolute;", "border-radius: 50%;"]);
      rule(".lo-o1", [
        `width: ${Math.round(h * 0.9)}px;`,
        `height: ${Math.round(h * 0.9)}px;`,
        `left: ${Math.round(w * 0.08)}px;`,
        `top: ${Math.round(h * 0.2)}px;`,
        `background: radial-gradient(circle, ${tint("accent", 70)}, transparent 70%);`,
      ]);
      rule(".lo-o2", [
        `width: ${Math.round(h * 0.75)}px;`,
        `height: ${Math.round(h * 0.75)}px;`,
        `left: ${Math.round(w * 0.5)}px;`,
        `top: ${Math.round(-h * 0.15)}px;`,
        `background: radial-gradient(circle, ${tint("secondary", 65)}, transparent 70%);`,
      ]);
      rule(".lo-o3", [
        `width: ${Math.round(h * 0.5)}px;`,
        `height: ${Math.round(h * 0.5)}px;`,
        `left: ${Math.round(w * 0.62)}px;`,
        `top: ${Math.round(h * 0.55)}px;`,
        `background: radial-gradient(circle, ${tint("primary", 60)}, transparent 70%);`,
      ]);
      rule(".lo-ptitle", [
        "position: absolute;",
        `left: ${px(ctx, 26)};`,
        `right: ${px(ctx, 26)};`,
        `bottom: ${px(ctx, 20)};`,
        ...fontCss(ctx, TEXT_STYLES.caption, 0.9, 700),
        "text-align: left;",
        "white-space: nowrap;",
        "overflow: hidden;",
        "text-overflow: ellipsis;",
      ]);
      rule(".lo-pplay", [
        "position: absolute;",
        "left: 50%;",
        "top: 50%;",
        `width: ${px(ctx, 110)};`,
        `height: ${px(ctx, 110)};`,
        `margin: -${px(ctx, 55)} 0 0 -${px(ctx, 55)};`,
        "border-radius: 50%;",
        "display: grid;",
        "place-items: center;",
        "background: var(--c-accent);",
        `color: ${inkOnAccent(ctx)};`,
      ]);
      rule(".lo-pplay svg", ["width: 46%;", "height: 46%;", "margin-left: 8%;"]);
      rule(".lo-pctl", ["display: flex;", "align-items: center;", `gap: ${gap}px;`, `width: ${w}px;`]);
      rule(".lo-pbtn", [`width: ${btn}px;`, `height: ${btn}px;`, "flex: 0 0 auto;", "opacity: 0.8;"]);
      rule(".lo-pbtn svg", ["width: 100%;", "height: 100%;"]);
      rule(".lo-pbar", [
        "position: relative;",
        `width: ${bar}px;`,
        `height: ${px(ctx, 8)};`,
        "border-radius: 999px;",
        `background: ${tint("foreground", 20)};`,
      ]);
      rule(".lo-pprog", [
        "position: absolute;",
        "inset: 0;",
        "border-radius: 999px;",
        "background: var(--c-accent);",
        "transform-origin: left center;",
        "transform: scaleX(0);",
      ]);
      rule(".lo-pkt", ["position: absolute;", "left: 0;", "top: 0;", "bottom: 0;", "width: 100%;"]);
      rule(".lo-pknob", [
        "position: absolute;",
        `left: -${Math.round(knob / 2)}px;`,
        "top: 50%;",
        `width: ${knob}px;`,
        `height: ${knob}px;`,
        `margin-top: -${Math.round(knob / 2)}px;`,
        "border-radius: 50%;",
        "background: var(--c-foreground);",
      ]);
      rule(".lo-approve", [
        ...fontCss(ctx, body, 0.95, 700),
        "display: flex;",
        "align-items: center;",
        `gap: ${px(ctx, 14)};`,
        `padding: ${px(ctx, 16)} ${px(ctx, 40)};`,
        "border-radius: 999px;",
        "background: var(--c-accent);",
        `color: ${inkOnAccent(ctx)};`,
        "opacity: 0;",
        "white-space: nowrap;",
      ]);
      rule(".lo-acheck", [
        "display: grid;",
        "place-items: center;",
        `width: ${px(ctx, 34)};`,
        `height: ${px(ctx, 34)};`,
        "opacity: 0;",
      ]);
      rule(".lo-acheck svg", ["width: 100%;", "height: 100%;"]);
      const title = layout.title ? `<div class="lo-ptitle">${escapeHtml(layout.title)}</div>` : "";
      const approve = `<div class="lo-approve"><span class="lo-acheck">${CHECK_SVG}</span><span>${escapeHtml(actionLabel)}</span></div>`;
      return done(
        `<div class="lo lo-player"><div class="lo-pmain"><div class="lo-screen"><div class="lo-art"><i class="lo-o1"></i><i class="lo-o2"></i><i class="lo-o3"></i></div>${title}<div class="lo-pplay">${PLAY_SVG}</div></div>` +
          `<div class="lo-pctl"><span class="lo-pbtn">${PLAY_SVG}</span><div class="lo-pbar"><div class="lo-pprog"></div><div class="lo-pkt"><div class="lo-pknob"></div></div></div></div></div>` +
          `${approve}</div>`,
      );
    }
    case "usage": {
      const words = uiWords(ctx.language);
      const w = Math.round(width * (portrait(ctx) ? 0.94 : 0.7));
      // The count steps keep the used amount's decimals, so its width holds still as it counts.
      const amount = (v: number, decimals = decimalsOf(layout.used)) =>
        `${layout.prefix ?? ""}${formatAmount(v, decimals, ctx.language)}${layout.suffix ? `\u200a${layout.suffix}` : ""}`;
      const cap = amount(layout.cap, decimalsOf(layout.cap));
      const chars = Array.from(`${amount(layout.used)} / ${cap}`).length;
      rule(".lo-usage", [
        "display: flex;",
        "flex-direction: column;",
        `gap: ${px(ctx, 22)};`,
        `width: ${w}px;`,
      ]);
      rule(".lo-uhead", [
        "display: flex;",
        "align-items: flex-end;",
        "justify-content: space-between;",
        `gap: ${px(ctx, 24)};`,
        "text-align: left;",
      ]);
      rule(".lo-ulabel", [...fontCss(ctx, body, 0.95, 600), "opacity: 0.8;", "min-width: 0;"]);
      rule(".lo-uval", [
        ...fontCss(ctx, TEXT_STYLES.heading, fitFactor(ctx, TEXT_STYLES.heading, 1, chars, w * 0.6), 800),
        "display: flex;",
        "align-items: baseline;",
        "white-space: nowrap;",
        "font-variant-numeric: tabular-nums;",
      ]);
      rule(".lo-unums", ["display: grid;", "justify-items: end;"]);
      rule(".lo-unums > span", ["grid-area: 1 / 1;", "opacity: 0;"]);
      rule(".lo-ucapv", ["opacity: 0.55;"]);
      rule(".lo-utrack", [
        "position: relative;",
        `height: ${px(ctx, 30)};`,
        "border-radius: 999px;",
        `background: ${tint("foreground", 12)};`,
      ]);
      rule(".lo-ufill", [
        "position: absolute;",
        "inset: 0;",
        "border-radius: 999px;",
        "background: var(--c-accent);",
        "transform-origin: left center;",
        "transform: scaleX(0);",
      ]);
      rule(".lo-ucap", [
        "position: absolute;",
        `right: -${px(ctx, 3)};`,
        `top: -${px(ctx, 14)};`,
        `bottom: -${px(ctx, 14)};`,
        `width: ${px(ctx, 6)};`,
        "border-radius: 999px;",
        "background: var(--c-foreground);",
      ]);
      rule(".lo-uscale", [
        ...fontCss(ctx, TEXT_STYLES.caption, 0.85, 600),
        "display: flex;",
        "justify-content: space-between;",
        "opacity: 0.7;",
      ]);
      const steps = Array.from({ length: USAGE_STEPS + 1 }, (_, k) =>
        k === USAGE_STEPS ? layout.used : (layout.used * k) / USAGE_STEPS,
      )
        .map((v, k) => `<span class="lo-u${k}">${escapeHtml(amount(v))}</span>`)
        .join("");
      const label = layout.label
        ? `<span class="lo-ulabel">${escapeHtml(layout.label)}</span>`
        : "<span></span>";
      return done(
        `<div class="lo lo-usage"><div class="lo-uhead">${label}<span class="lo-uval"><span class="lo-unums">${steps}</span><span class="lo-ucapv">&#8201;/&#8201;${escapeHtml(cap)}</span></span></div>` +
          `<div class="lo-utrack"><div class="lo-ufill"></div><div class="lo-ucap"></div></div>` +
          `<div class="lo-uscale"><span>${escapeHtml(amount(0, 0))}</span><span>${escapeHtml(words.cap)} &#183; ${escapeHtml(cap)}</span></div></div>`,
      );
    }
  }
}

/** One staggered build: `n` parts start `step` ms apart from `startMs`, so all start within `spanMs`. */
function stagger(n: number, startMs: number, spanMs: number, maxStepMs: number) {
  const step = n > 1 ? Math.min(maxStepMs, Math.floor(spanMs / (n - 1))) : 0;
  return (i: number) => seconds(startMs + i * step);
}

const EASE = "power3.out";

/**
 * The inner motion of a layout shot: its parts build in after the shot's own entrance and settle well before
 * it ends. Times are scene-local; `shot` gives the shot's window.
 */
export function writeLayoutMotion(
  w: TimelineWriter,
  sel: string,
  shot: { startMs: number; durationMs: number; layout: LayoutSpec },
  frame: { width: number; height: number },
): void {
  const { layout } = shot;
  const begin = shot.startMs + Math.min(300, Math.floor(shot.durationMs * 0.1));
  // Builds use at most half the shot, so the finished layout holds on screen at least as long.
  const span = Math.max(0, Math.floor(shot.durationMs * 0.5) - (begin - shot.startMs));
  const end = shot.startMs + shot.durationMs;
  const rise = Math.round(0.03 * Math.min(frame.width, frame.height));
  const dur = (ms: number) => seconds(Math.min(ms, Math.max(100, Math.floor(span / 2))));
  const pop = (target: string, at: number, ms = 420) =>
    w.fromTo(
      target,
      { opacity: 0, scale: 0.6 },
      { opacity: 1, scale: 1, duration: dur(ms), ease: "back.out(1.7)" },
      at,
    );
  const upIn = (target: string, at: number, ms = 450) =>
    w.fromTo(target, { opacity: 0, y: rise }, { opacity: 1, y: 0, duration: dur(ms), ease: EASE }, at);

  switch (layout.kind) {
    case "prompt-box": {
      const chunks = typingChunks(layout.text, TYPING_STEPS).length;
      const typeMs = Math.min(chunks * 55, Math.floor(span * 0.75));
      const at = stagger(chunks, begin, typeMs, 80);
      for (let i = 0; i < chunks; i++) w.set(`${sel} .lo-c${i}`, { opacity: 1 }, at(i));
      const typed = begin + typeMs;
      // The caret blinks from the last letter to the end of the shot.
      const caret = `${sel} .lo-caret`;
      for (let t = typed, on = true; t < end - 100; t += 500, on = !on) {
        w.set(caret, { opacity: on ? 1 : 0 }, seconds(t));
      }
      if (layout.action) {
        const send = `${sel} .lo-send`;
        pop(send, seconds(typed + 120));
        const press = typed + 120 + 480;
        if (press + 260 < end) {
          w.fromTo(send, { scale: 1 }, { scale: 0.9, duration: 0.12, ease: "power2.in" }, seconds(press));
          w.fromTo(send, { scale: 0.9 }, { scale: 1, duration: 0.14, ease: EASE }, seconds(press + 120));
        }
      }
      return;
    }
    case "code": {
      const n = layout.lines.length;
      const at = stagger(n, begin, Math.floor(span * 0.7), 260);
      for (let i = 0; i < n; i++) {
        w.fromTo(
          `${sel} .lo-l${i}`,
          { clipPath: "inset(0% 100% 0% 0%)" },
          { clipPath: "inset(0% 0% 0% 0%)", duration: dur(320), ease: "power2.out" },
          at(i),
        );
      }
      const marked = new Set(layout.highlight ?? []);
      for (const i of [...marked].filter((i) => i < n).sort((a, b) => a - b)) {
        w.fromTo(
          `${sel} .lo-l${i} .lo-hlbar`,
          { scaleX: 0 },
          { scaleX: 1, duration: dur(380), ease: EASE },
          seconds(begin + Math.floor(span * 0.75)),
        );
      }
      return;
    }
    case "chips": {
      const n = layout.items.length;
      // Fixed offsets for a long shot, squeezed with the span so a short card builds before it exits.
      const f = Math.min(1, span / 1000);
      pop(`${sel} .lo-hub`, seconds(begin));
      const wire = begin + Math.round(260 * f);
      w.fromTo(
        `${sel} .lo-stem`,
        { scaleY: 0 },
        { scaleY: 1, duration: dur(220), ease: EASE },
        seconds(wire),
      );
      const { column } = chipsPlan(layout.items, frame);
      w.fromTo(
        `${sel} .lo-bus`,
        column ? { scaleY: 0 } : { scaleX: 0 },
        { ...(column ? { scaleY: 1 } : { scaleX: 1 }), duration: dur(320), ease: EASE },
        seconds(wire + Math.round(180 * f)),
      );
      const at = stagger(n, wire + Math.round(380 * f), Math.max(0, span - Math.round(640 * f)), 160);
      for (let i = 0; i < n; i++) {
        w.fromTo(
          `${sel} .lo-i${i} .lo-drop`,
          column ? { scaleX: 0 } : { scaleY: 0 },
          { ...(column ? { scaleX: 1 } : { scaleY: 1 }), duration: dur(180), ease: EASE },
          at(i),
        );
        pop(`${sel} .lo-i${i} .lo-chip`, seconds(Math.round(at(i) * 1000) + Math.round(120 * f)), 380);
      }
      return;
    }
    case "checklist": {
      const n = layout.items.length;
      const at = stagger(n, begin, Math.floor(span * 0.6), 280);
      layout.items.forEach((item, i) => {
        upIn(`${sel} .lo-s${i}`, at(i));
        if (item.state === "done") pop(`${sel} .lo-s${i} .lo-tick`, at(i) + 0.22, 360);
        if (item.state === "active") {
          const dot = `${sel} .lo-s${i} .lo-dot`;
          const from = at(i) + 0.22;
          pop(dot, from, 360);
          // Two slow pulses mark the step in progress.
          for (let k = 0; k < 2; k++) {
            const t = from + 0.5 + k * 0.8;
            if (t + 0.7 > seconds(end)) break;
            w.fromTo(dot, { scale: 1 }, { scale: 1.35, duration: 0.35, ease: "sine.inOut" }, t);
            w.fromTo(dot, { scale: 1.35 }, { scale: 1, duration: 0.35, ease: "sine.inOut" }, t + 0.35);
          }
        }
      });
      return;
    }
    case "counter": {
      // The schema keeps `from <= to`, so `to` has at least as many digits.
      const to = String(layout.to);
      const from = String(layout.from).padStart(to.length, "0");
      const lead = to.length - String(layout.from).length;
      const rollMs = Math.max(100, Math.min(1600, span));
      const roll = seconds(rollMs);
      // Digits `from` does not have (and their separators) appear as the count grows into them.
      for (let c = 0; c < lead; c++) {
        const show = { opacity: 1, duration: seconds(Math.max(100, Math.round(rollMs * 0.3))), ease: EASE };
        const at = seconds(begin + Math.round(rollMs * 0.1 * (lead - c)));
        w.fromTo(`${sel} .lo-g${c}`, { opacity: 0 }, show, at);
        // A thousands separator follows a digit only where three or more digits come after it.
        const separated = c < to.length - 1 && (to.length - 1 - c) % 3 === 0;
        if (separated) w.fromTo(`${sel} .lo-p${c}`, { opacity: 0 }, show, at);
      }
      for (let c = 0; c < to.length; c++) {
        const turns = Math.max(0, 2 - (to.length - 1 - c)); // the units spin twice, tens once
        const startIdx = Number(from[c]);
        const endIdx = Number(to[c]) + 10 * turns;
        const pct = (idx: number) => -Math.round((idx / STRIP.length) * 100_000) / 1000;
        w.fromTo(
          `${sel} .lo-d${c}`,
          { yPercent: pct(startIdx) },
          { yPercent: pct(endIdx), duration: roll, ease: "power2.out" },
          seconds(begin),
        );
      }
      if (layout.label) upIn(`${sel} .lo-clabel`, seconds(begin + 200));
      return;
    }
    case "cards-row": {
      const n = layout.items.length;
      const at = stagger(n, begin, Math.floor(span * 0.6), 180);
      for (let i = 0; i < n; i++) upIn(`${sel} .lo-k${i}`, at(i));
      const hot = layout.highlight;
      if (hot !== undefined && hot < n) {
        // Only once every card has landed, so no card jumps to full opacity mid-entrance.
        const t = Math.max(seconds(begin + Math.floor(span * 0.8)), at(n - 1) + dur(450));
        w.fromTo(`${sel} .lo-k${hot}`, { scale: 1 }, { scale: 1.07, duration: dur(400), ease: EASE }, t);
        for (let i = 0; i < n; i++) {
          if (i !== hot)
            w.fromTo(`${sel} .lo-k${i}`, { opacity: 1 }, { opacity: 0.5, duration: dur(400), ease: EASE }, t);
        }
      }
      return;
    }
    case "swatches": {
      const n = layout.items.length;
      const at = stagger(n, begin, Math.floor(span * 0.6), 140);
      for (let i = 0; i < n; i++) pop(`${sel} .lo-w${i}`, at(i));
      return;
    }
    case "stat": {
      pop(`${sel} .lo-value`, seconds(begin), 500);
      w.fromTo(
        `${sel} .lo-rule`,
        { scaleX: 0 },
        { scaleX: 1, duration: dur(380), ease: EASE },
        seconds(begin + 280),
      );
      upIn(`${sel} .lo-slabel`, seconds(begin + 420));
      return;
    }
    case "chat": {
      // Type the prompt, send it (it rises into the thread as a bubble), then the reply after a typing pause.
      const chunks = typingChunks(layout.prompt, TYPING_STEPS).length;
      const typeMs = Math.min(chunks * 45, Math.floor(span * 0.7));
      const at = stagger(chunks, begin, typeMs, 70);
      for (let i = 0; i < chunks; i++) w.set(`${sel} .lo-c${i}`, { opacity: 1 }, at(i));
      const typed = begin + typeMs;
      const rest = Math.max(0, end - typed);
      const send = typed + Math.min(350, Math.floor(rest * 0.12));
      const caret = `${sel} .lo-caret`;
      for (let t = typed, on = true; t < send; t += 300, on = !on)
        w.set(caret, { opacity: on ? 1 : 0 }, seconds(t));
      w.set(caret, { opacity: 0 }, seconds(send));
      const go = `${sel} .lo-go`;
      w.fromTo(go, { scale: 1 }, { scale: 0.85, duration: 0.1, ease: "power2.in" }, seconds(send - 100));
      w.fromTo(go, { scale: 0.85 }, { scale: 1, duration: 0.14, ease: EASE }, seconds(send));
      w.set(`${sel} .lo-typed`, { opacity: 0 }, seconds(send));
      upIn(`${sel} .lo-me`, seconds(send), 380);
      if (layout.reply) {
        const dots = send + Math.min(400, Math.floor(rest * 0.12));
        const reply = dots + Math.min(1000, Math.floor(rest * 0.3));
        pop(`${sel} .lo-dots`, seconds(dots), 300);
        // The dots hop one after another until the reply lands.
        for (let t = dots + 250, k = 0; t + 300 < reply; t += 200, k++) {
          const dot = `${sel} .lo-dt${k % 3}`;
          w.fromTo(dot, { y: 0 }, { y: -rise / 3, duration: 0.15, ease: "sine.out" }, seconds(t));
          w.fromTo(dot, { y: -rise / 3 }, { y: 0, duration: 0.15, ease: "sine.in" }, seconds(t + 150));
        }
        w.set(`${sel} .lo-dots`, { opacity: 0 }, seconds(reply));
        upIn(`${sel} .lo-ai`, seconds(reply), 380);
      }
      return;
    }
    case "tool-call": {
      const n = layout.args?.length ?? 0;
      const at = stagger(n, begin + 200, Math.floor(span * 0.5), 160);
      for (let i = 0; i < n; i++) upIn(`${sel} .lo-a${i}`, at(i), 360);
      // The spinner turns until the call is done (or the card ends while it runs): one turn per 700 ms.
      const doneAt =
        layout.status === "done"
          ? Math.max(begin + 300, Math.min(begin + Math.floor(span * 1.2), end - 900))
          : end;
      for (let t = begin, k = 0; t < doneAt; t += 700, k++) {
        w.fromTo(
          `${sel} .lo-spin`,
          { rotation: k * 360 },
          { rotation: (k + 1) * 360, duration: 0.7, ease: "none" },
          seconds(t),
        );
      }
      if (layout.status === "done") {
        w.set(`${sel} .lo-trun`, { opacity: 0 }, seconds(doneAt));
        pop(`${sel} .lo-tok`, seconds(doneAt), 360);
        pop(`${sel} .lo-tick`, seconds(doneAt + 80), 360);
        if (layout.result) upIn(`${sel} .lo-tres`, seconds(doneAt + 220), 380);
      }
      return;
    }
    case "pipeline": {
      const n = layout.items.length;
      const reach = pipelineReach(layout);
      const column = pipelineColumn(n, frame);
      const step = reach > 0 ? Math.min(600, Math.floor((span * 0.9) / reach)) : 0;
      const lit = (i: number) => begin + i * step;
      if (reach > 0) {
        const to = reach / (n - 1);
        w.fromTo(
          `${sel} .lo-pfill`,
          column ? { scaleY: 0 } : { scaleX: 0 },
          { ...(column ? { scaleY: to } : { scaleX: to }), duration: seconds(reach * step), ease: "none" },
          seconds(begin),
        );
      } else {
        w.set(`${sel} .lo-pfill`, column ? { scaleY: 0 } : { scaleX: 0 }, seconds(shot.startMs));
      }
      for (let i = 0; i <= reach; i++) {
        const node = `${sel} .lo-n${i}`;
        w.fromTo(
          `${node} .lo-plabel`,
          { opacity: 0.55 },
          { opacity: 1, duration: dur(300), ease: EASE },
          seconds(lit(i)),
        );
        const active = i === reach && layout.active !== undefined;
        if (!active) {
          pop(`${node} .lo-ptick`, seconds(lit(i)), 360);
          continue;
        }
        pop(`${node} .lo-pring`, seconds(lit(i)), 360);
        const dot = `${node} .lo-pdot`;
        pop(dot, seconds(lit(i) + 120), 360);
        // The running stage pulses for as long as the card holds.
        for (let t = lit(i) + 700; t + 700 < end; t += 800) {
          w.fromTo(dot, { scale: 1 }, { scale: 1.35, duration: 0.35, ease: "sine.inOut" }, seconds(t));
          w.fromTo(dot, { scale: 1.35 }, { scale: 1, duration: 0.35, ease: "sine.inOut" }, seconds(t + 350));
        }
      }
      return;
    }
    case "player": {
      // Press play, play to the end (the art drifts, the scrubber runs), then the approve button is pressed.
      const window = Math.max(600, end - begin - 200);
      const play = begin + Math.round(window * 0.08);
      const played = begin + Math.round(window * 0.5);
      const approve = begin + Math.round(window * 0.56);
      const press = begin + Math.round(window * 0.72);
      const playMs = played - play;
      const big = `${sel} .lo-pplay`;
      w.fromTo(big, { scale: 1 }, { scale: 0.88, duration: 0.1, ease: "power2.in" }, seconds(play - 100));
      w.fromTo(
        big,
        { opacity: 1, scale: 0.88 },
        { opacity: 0, scale: 1.3, duration: 0.3, ease: EASE },
        seconds(play),
      );
      w.fromTo(
        `${sel} .lo-pprog`,
        { scaleX: 0 },
        { scaleX: 1, duration: seconds(playMs), ease: "none" },
        seconds(play),
      );
      // The knob rides a track as wide as the bar, so a 100% shift lands it at the end.
      w.fromTo(
        `${sel} .lo-pkt`,
        { xPercent: 0 },
        { xPercent: 100, duration: seconds(playMs), ease: "none" },
        seconds(play),
      );
      const drift = Math.round(0.04 * Math.min(frame.width, frame.height));
      ["lo-o1", "lo-o2", "lo-o3"].forEach((orb, i) => {
        const dx = (i % 2 === 0 ? 1 : -1) * drift;
        w.fromTo(
          `${sel} .${orb}`,
          { x: 0, y: 0, scale: 1 },
          { x: dx, y: -dx / 2, scale: 1.15, duration: seconds(playMs), ease: "sine.inOut" },
          seconds(play),
        );
      });
      pop(`${sel} .lo-approve`, seconds(approve), 420);
      const btn = `${sel} .lo-approve`;
      if (press + 300 < end) {
        w.fromTo(btn, { scale: 1 }, { scale: 0.9, duration: 0.12, ease: "power2.in" }, seconds(press));
        w.fromTo(btn, { scale: 0.9 }, { scale: 1.06, duration: 0.18, ease: EASE }, seconds(press + 120));
        pop(`${sel} .lo-acheck`, seconds(press + 120), 320);
      }
      return;
    }
    case "usage": {
      const rollMs = Math.max(200, Math.min(1800, span));
      w.fromTo(
        `${sel} .lo-ufill`,
        { scaleX: 0 },
        { scaleX: layout.used / layout.cap, duration: seconds(rollMs), ease: "power2.out" },
        seconds(begin),
      );
      // The amount counts up with the fill: power2.out is 1 - (1 - t)^3, so step k of N shows at the time the
      // fill reaches k/N of its length.
      w.set(`${sel} .lo-u0`, { opacity: 1 }, seconds(shot.startMs));
      for (let k = 1; k <= USAGE_STEPS; k++) {
        const t = begin + Math.round(rollMs * (1 - (1 - k / USAGE_STEPS) ** (1 / 3)));
        w.set(`${sel} .lo-u${k - 1}`, { opacity: 0 }, seconds(t));
        w.set(`${sel} .lo-u${k}`, { opacity: 1 }, seconds(t));
      }
      if (layout.used >= layout.cap) {
        // At the cap the marker knocks twice: the meter stops here.
        const cap = `${sel} .lo-ucap`;
        for (let k = 0; k < 2; k++) {
          const t = begin + rollMs + 100 + k * 500;
          if (t + 400 > end) break;
          w.fromTo(cap, { scaleY: 1 }, { scaleY: 1.5, duration: 0.18, ease: "power2.out" }, seconds(t));
          w.fromTo(cap, { scaleY: 1.5 }, { scaleY: 1, duration: 0.2, ease: "power2.in" }, seconds(t + 180));
        }
      }
      return;
    }
  }
}
