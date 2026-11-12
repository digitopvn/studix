import type { LayoutSpec } from "@studix/video-ir";
import {
  burnedCaptionBand,
  cssColor,
  frameScale,
  TEXT_STYLES,
  type TextStyleToken,
  tint,
} from "./brand-tokens.ts";
import { cssRule, escapeHtml, seconds } from "./html-utils.ts";
import type { TimelineWriter } from "./scene-timeline.ts";
import type { ShotMarkup, ShotMarkupContext } from "./shot-markup.ts";

/**
 * Built-in layouts (`LayoutSpec`): typed content drawn as HTML and animated by the scene timeline. Every
 * colour is a palette role (stage CSS variable), so a brand kit or style profile restyles them all, and every
 * size scales with the short frame edge like the text styles do. Motion follows the timeline rules in
 * scene-timeline.ts: absolute positions, opacity, transforms and clip-path only.
 */

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
  if (!landscape(ctx.frame)) return (height - 2 * safe - captions) * (portrait(ctx) ? 0.7 : 0.55);
  // Landscape: the content area less a two-line display headline, the gaps around it and the band the
  // captions keep at the bottom (see scene-composition.ts).
  const headline =
    2 * TEXT_STYLES.display.sizeAt1080 * TEXT_STYLES.display.lineHeight * frameScale(ctx.frame);
  return height - 2 * safe - headline - 2 * gap - captions;
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

const vietnamese = (language: string | undefined) => language?.toLowerCase().startsWith("vi") ?? false;

/** Words the product UI layouts print themselves, in the IR's language. */
function uiWords(language: string | undefined) {
  return vietnamese(language)
    ? { running: "Đang chạy", done: "Xong", approve: "Duyệt", cap: "Hạn mức" }
    : { running: "Running", done: "Done", approve: "Approve", cap: "Cap" };
}

/** A meter amount: whole numbers grouped by thousands, decimals with the language's decimal mark. */
function amount(n: number, language: string | undefined): string {
  if (Number.isInteger(n)) return groupDigits(n, language);
  // 4.999 rounds to "5.00": trim the zeros and the point with them, so it reads "5", never "5.".
  const [whole, frac] = n
    .toFixed(2)
    .replace(/\.?0+$/, "")
    .split(".");
  const head = groupDigits(Number(whole), language);
  return frac ? `${head}${vietnamese(language) ? "," : "."}${frac}` : head;
}

const PLAY_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';

/** A spinner ring: a faint circle with one accent quarter, turned by the timeline. */
function spinnerCss(rule: (s: string, decls: string[]) => void, cls: string, size: string, stroke: string) {
  rule(cls, [
    "display: inline-block;",
    "flex: 0 0 auto;",
    `width: ${size};`,
    `height: ${size};`,
    "border-radius: 50%;",
    `border: ${stroke} solid ${tint("foreground", 18)};`,
    "border-top-color: var(--c-accent);",
    "box-sizing: border-box;",
  ]);
}

/**
 * Bubble type size of a chat layout: the body size, shrunk until every message, wrapped to the bubble
 * width, fits the height a layout may take.
 */
function chatFactor(ctx: ShotMarkupContext, texts: readonly string[], bubble: number, room: number): number {
  let k = 1;
  for (let pass = 0; pass < 3; pass++) {
    const font = TEXT_STYLES.body.sizeAt1080 * ctx.scale * 0.95 * k;
    const perLine = Math.max(4, Math.floor((bubble - 2 * 28 * ctx.scale) / (0.55 * font)));
    const height = texts.reduce(
      (h, t) =>
        h + Math.ceil(Array.from(t).length / perLine) * font * 1.3 + 2 * 18 * ctx.scale + 16 * ctx.scale,
      120 * ctx.scale,
    );
    k = Math.min(1, k * (room / height));
  }
  return Math.max(0.55, k);
}

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
      const chatWidth = Math.round(width * (portrait(ctx) ? 1 : 0.78));
      const k = chatFactor(
        ctx,
        layout.messages.map((m) => m.text),
        chatWidth * 0.82,
        layoutHeight(ctx) - (layout.title ? 70 * ctx.scale : 0),
      );
      rule(".lo-chat", [
        `width: ${chatWidth}px;`,
        `border: ${px(ctx, 2)} solid ${tint("foreground", 18)};`,
        `border-radius: ${px(ctx, 28)};`,
        `background: ${tint("foreground", 6)};`,
        "overflow: hidden;",
        "text-align: left;",
      ]);
      rule(".lo-ctitle", [
        ...fontCss(ctx, TEXT_STYLES.caption, 0.85, 600),
        "display: flex;",
        "align-items: center;",
        `gap: ${px(ctx, 14)};`,
        `padding: ${px(ctx, 16)} ${px(ctx, 26)};`,
        `border-bottom: ${px(ctx, 2)} solid ${tint("foreground", 12)};`,
      ]);
      rule(".lo-ctitle i", [
        `width: ${px(ctx, 16)};`,
        `height: ${px(ctx, 16)};`,
        "border-radius: 50%;",
        "background: var(--c-accent);",
      ]);
      rule(".lo-msgs", [
        "display: flex;",
        "flex-direction: column;",
        `gap: ${px(ctx, 16 * k)};`,
        `padding: ${px(ctx, 24 * k)};`,
      ]);
      rule(".lo-msg", [
        ...fontCss(ctx, body, 0.95 * k, 500),
        "max-width: 82%;",
        `padding: ${px(ctx, 18 * k)} ${px(ctx, 28 * k)};`,
        `border-radius: ${px(ctx, 26 * k)};`,
        "overflow-wrap: anywhere;",
        "line-height: 1.3;",
      ]);
      rule(".lo-user", [
        "align-self: flex-end;",
        "background: var(--c-accent);",
        `color: ${inkOnAccent(ctx)};`,
        `border-bottom-right-radius: ${px(ctx, 8)};`,
      ]);
      rule(".lo-agent", [
        "align-self: flex-start;",
        `background: ${tint("foreground", 12)};`,
        `border-bottom-left-radius: ${px(ctx, 8)};`,
      ]);
      rule(".lo-ch", ["opacity: 0;"]);
      const msgs = layout.messages
        .map((m, i) => {
          const text =
            m.from === "user"
              ? typingChunks(m.text, TYPING_STEPS)
                  .map((c, j) => `<span class="lo-ch lo-m${i}c${j}">${escapeHtml(c)}</span>`)
                  .join("")
              : escapeHtml(m.text);
          return `<div class="lo-msg lo-m${i} lo-${m.from}">${text}</div>`;
        })
        .join("");
      const title = layout.title ? `<div class="lo-ctitle"><i></i>${escapeHtml(layout.title)}</div>` : "";
      return done(`<div class="lo lo-chat">${title}<div class="lo-msgs">${msgs}</div></div>`);
    }
    case "tool-call": {
      const words = uiWords(ctx.language);
      const cardWidth = Math.round(width * (portrait(ctx) ? 1 : 0.74));
      const mono = Math.min(
        Math.round(body.sizeAt1080 * ctx.scale * 0.85),
        Math.floor(
          (cardWidth * 0.9) /
            (Math.max(16, ...(layout.args ?? []).map((a) => a.key.length + a.value.length + 4)) * 0.6),
        ),
      );
      ctx.fontWeights.mono.add(500);
      ctx.fontWeights.mono.add(700);
      rule(".lo-tool", [
        `width: ${cardWidth}px;`,
        `border: ${px(ctx, 3)} solid ${tint("foreground", 18)};`,
        `border-radius: ${px(ctx, 26)};`,
        `background: ${tint("foreground", 6)};`,
        `padding: ${px(ctx, 26)} ${px(ctx, 30)};`,
        "box-sizing: border-box;",
        "text-align: left;",
        "display: flex;",
        "flex-direction: column;",
        `gap: ${px(ctx, 18)};`,
      ]);
      rule(".lo-thead", ["display: flex;", "align-items: center;", `gap: ${px(ctx, 18)};`]);
      rule(".lo-tname", [
        `font-family: ${ctx.fontStacks.mono};`,
        `font-size: ${Math.round(body.sizeAt1080 * ctx.scale * fitFactor(ctx, body, 1, layout.name.length + 12, cardWidth))}px;`,
        "font-weight: 700;",
        "flex: 1 1 auto;",
        "min-width: 0;",
        "overflow-wrap: anywhere;",
      ]);
      rule(".lo-tstate", ["display: grid;", "flex: 0 0 auto;"]);
      rule(".lo-tstate > *", ["grid-area: 1 / 1;", "justify-self: end;"]);
      rule(".lo-pill", [
        ...fontCss(ctx, TEXT_STYLES.caption, 0.85, 700),
        "display: inline-flex;",
        "align-items: center;",
        `gap: ${px(ctx, 12)};`,
        `padding: ${px(ctx, 10)} ${px(ctx, 22)};`,
        "border-radius: 999px;",
        "white-space: nowrap;",
      ]);
      rule(".lo-run", [`background: ${tint("accent", 16)};`]);
      rule(".lo-ok", ["background: var(--c-accent);", `color: ${inkOnAccent(ctx)};`, "opacity: 0;"]);
      rule(".lo-ok svg", ["width: 1.1em;", "height: 1.1em;"]);
      spinnerCss(rule, ".lo-spin", "1.05em", px(ctx, 4));
      rule(".lo-args", [
        `font-family: ${ctx.fontStacks.mono};`,
        `font-size: ${mono}px;`,
        "font-weight: 500;",
        "line-height: 1.5;",
        `padding: ${px(ctx, 14)} ${px(ctx, 20)};`,
        `border-radius: ${px(ctx, 16)};`,
        `background: ${tint("foreground", 6)};`,
        "white-space: pre-wrap;",
        "overflow-wrap: anywhere;",
      ]);
      rule(".lo-key", ["opacity: 0.6;"]);
      rule(".lo-val", ["color: var(--c-accent);"]);
      rule(".lo-result", [
        ...fontCss(ctx, body, 0.9, 600),
        "display: flex;",
        "align-items: center;",
        `gap: ${px(ctx, 14)};`,
        "opacity: 0;",
      ]);
      rule(".lo-result svg", [
        "width: 1.1em;",
        "height: 1.1em;",
        "color: var(--c-accent);",
        "flex: 0 0 auto;",
      ]);
      const args = (layout.args ?? [])
        .map(
          (a, i) =>
            `<div class="lo-arg lo-a${i}"><span class="lo-key">${escapeHtml(a.key)}: </span><span class="lo-val">${escapeHtml(a.value)}</span></div>`,
        )
        .join("");
      const ok =
        layout.status === "done"
          ? `<span class="lo-pill lo-ok">${CHECK_SVG}${escapeHtml(words.done)}</span>`
          : "";
      const result =
        layout.status === "done" && layout.result
          ? `<div class="lo-result">${CHECK_SVG}<span>${escapeHtml(layout.result)}</span></div>`
          : "";
      return done(
        `<div class="lo lo-tool"><div class="lo-thead"><span class="lo-tname">${escapeHtml(layout.name)}</span><span class="lo-tstate"><span class="lo-pill lo-run"><span class="lo-spin"></span>${escapeHtml(words.running)}</span>${ok}</span></div>${args ? `<div class="lo-args">${args}</div>` : ""}${result}</div>`,
      );
    }
    case "pipeline": {
      const n = layout.steps.length;
      const column = portrait(ctx) && n > 3;
      // A column step is about 100 px tall at 1080 with 26 px between: it shrinks to the height left.
      const k = column ? Math.min(1, layoutHeight(ctx) / ((n * 100 + (n - 1) * 26) * ctx.scale)) : 1;
      const c = k < 1 ? { ...ctx, scale: ctx.scale * k } : ctx;
      const rowWidth = Math.round(width * (column ? 0.86 : 0.96));
      const mark = column ? 72 : Math.min(84, (rowWidth / ctx.scale / n) * 0.55);
      const longest = Math.max(
        ...layout.steps.flatMap((s) => s.label.split(/\s+/).map((w) => Array.from(w).length)),
      );
      const labelFactor = column
        ? 1.05
        : Math.max(
            0.55,
            Math.min(0.9, ((rowWidth / n) * 0.92) / (longest * 0.6 * body.sizeAt1080 * ctx.scale)),
          );
      rule(".lo-pipe", [
        "position: relative;",
        "display: grid;",
        column ? `gap: ${px(c, 26)};` : `grid-template-columns: repeat(${n}, minmax(0, 1fr));`,
        `width: ${rowWidth}px;`,
        "text-align: left;",
      ]);
      rule(".lo-node", [
        "position: relative;",
        "display: flex;",
        column ? "flex-direction: row;" : "flex-direction: column;",
        "align-items: center;",
        `gap: ${px(c, column ? 26 : 18)};`,
        "min-width: 0;",
      ]);
      rule(".lo-pmark", [
        "position: relative;",
        "z-index: 1;",
        "flex: 0 0 auto;",
        `width: ${px(c, mark)};`,
        `height: ${px(c, mark)};`,
        "border-radius: 50%;",
        `border: ${px(c, 4)} solid ${tint("foreground", 35)};`,
        "background: var(--c-background);",
        "box-sizing: border-box;",
        "display: grid;",
        "place-items: center;",
      ]);
      rule(".lo-done .lo-pmark", [
        "border-color: var(--c-accent);",
        "background: var(--c-accent);",
        `color: ${inkOnAccent(c)};`,
      ]);
      rule(".lo-active .lo-pmark", ["border-color: var(--c-accent);"]);
      rule(".lo-pmark svg", ["width: 58%;", "height: 58%;"]);
      rule(".lo-pdot", [
        "width: 38%;",
        "height: 38%;",
        "border-radius: 50%;",
        "background: var(--c-accent);",
      ]);
      spinnerCss(rule, ".lo-pspin", `calc(100% + ${px(c, 20)})`, px(c, 4));
      rule(".lo-pspin", [
        "position: absolute;",
        `inset: -${px(c, 10)};`,
        "width: auto;",
        "height: auto;",
        "opacity: 0;",
      ]);
      rule(".lo-plabel", [
        ...fontCss(c, body, labelFactor, 600),
        column ? "text-align: left;" : "text-align: center;",
        "overflow-wrap: anywhere;",
        "min-width: 0;",
      ]);
      rule(".lo-todo .lo-plabel", ["opacity: 0.6;"]);
      // Links run between neighbouring marks' centres, behind them; a link fills once the step after it starts.
      const half = `calc(${px(c, mark)} / 2)`;
      rule(
        ".lo-link",
        column
          ? [
              "position: absolute;",
              `left: calc(${half} - ${px(c, 2)});`,
              `width: ${px(c, 4)};`,
              `background: ${tint("foreground", 22)};`,
            ]
          : [
              "position: absolute;",
              `top: calc(${half} - ${px(c, 2)});`,
              `height: ${px(c, 4)};`,
              `width: calc(100% / ${n});`,
              `background: ${tint("foreground", 22)};`,
            ],
      );
      rule(".lo-lfill", [
        "position: absolute;",
        "inset: 0;",
        "background: var(--c-accent);",
        column ? "transform-origin: top center;" : "transform-origin: left center;",
      ]);
      const links = layout.steps
        .slice(0, -1)
        .map((_step, i) => {
          const next = layout.steps[i + 1];
          const filled = next && next.state !== "todo";
          const pos = column
            ? `top: calc(${i} * (100% + ${px(c, 26)}) / ${n} + ${half}); height: calc((100% + ${px(c, 26)}) / ${n});`
            : `left: calc(${2 * i + 1} * 100% / ${2 * n});`;
          return `<div class="lo-link lo-n${i}" style="${pos}">${filled ? '<div class="lo-lfill"></div>' : ""}</div>`;
        })
        .join("");
      const nodes = layout.steps
        .map((step, i) => {
          const inner =
            step.state === "done"
              ? CHECK_SVG
              : step.state === "active"
                ? '<span class="lo-pdot"></span><span class="lo-pspin"></span>'
                : "";
          return `<div class="lo-node lo-p${i} lo-${step.state}"><span class="lo-pmark">${inner}</span><span class="lo-plabel">${escapeHtml(step.label)}</span></div>`;
        })
        .join("");
      return done(`<div class="lo lo-pipe">${links}${nodes}</div>`);
    }
    case "player": {
      const words = uiWords(ctx.language);
      // In a landscape card the Approve button stands beside the player, so the player takes the full height.
      const wide = landscape(ctx.frame);
      const controls = (wide ? 70 : 200) * ctx.scale;
      const maxWidth = width * (portrait(ctx) ? 1 : wide ? 0.62 : 0.72);
      const screenWidth = Math.round(Math.min(maxWidth, ((layoutHeight(ctx) - controls) * 16) / 9));
      const screenHeight = Math.round((screenWidth * 9) / 16);
      rule(".lo-player", [
        "display: flex;",
        wide ? "flex-direction: row;" : "flex-direction: column;",
        "align-items: center;",
        `gap: ${px(ctx, wide ? 40 : 22)};`,
      ]);
      rule(".lo-frame", [
        `width: ${screenWidth}px;`,
        `border-radius: ${px(ctx, 24)};`,
        "overflow: hidden;",
        `border: ${px(ctx, 3)} solid ${tint("foreground", 18)};`,
        `background: ${tint("foreground", 6)};`,
      ]);
      rule(".lo-screen", [
        "position: relative;",
        `height: ${screenHeight}px;`,
        `background: linear-gradient(135deg, ${tint("accent", 55)}, ${tint("primary", 25)} 60%, ${tint("foreground", 10)});`,
      ]);
      rule(".lo-ptitle", [
        ...fontCss(
          ctx,
          TEXT_STYLES.heading,
          fitFactor(ctx, TEXT_STYLES.heading, 0.7, Math.min(layout.title.length, 28), screenWidth),
          700,
        ),
        "position: absolute;",
        `left: ${px(ctx, 26)};`,
        `right: ${px(ctx, 26)};`,
        `bottom: ${px(ctx, 20)};`,
        "text-align: left;",
        "line-height: 1.15;",
        "overflow-wrap: anywhere;",
      ]);
      rule(".lo-play", [
        "position: absolute;",
        "left: 50%;",
        "top: 42%;",
        `width: ${px(ctx, 120)};`,
        `height: ${px(ctx, 120)};`,
        `margin: -${px(ctx, 60)} 0 0 -${px(ctx, 60)};`,
        "border-radius: 50%;",
        "background: var(--c-foreground);",
        "color: var(--c-background);",
        "display: grid;",
        "place-items: center;",
      ]);
      rule(".lo-play svg", ["width: 46%;", "height: 46%;", "margin-left: 8%;"]);
      rule(".lo-bar2", [
        "display: flex;",
        "align-items: center;",
        `gap: ${px(ctx, 18)};`,
        `padding: ${px(ctx, 16)} ${px(ctx, 22)};`,
        ...fontCss(ctx, TEXT_STYLES.caption, 0.8, 600),
      ]);
      rule(".lo-track", [
        "position: relative;",
        "flex: 1 1 auto;",
        `height: ${px(ctx, 10)};`,
        "border-radius: 999px;",
        `background: ${tint("foreground", 18)};`,
        "overflow: hidden;",
      ]);
      rule(".lo-prog", [
        "position: absolute;",
        "inset: 0;",
        "background: var(--c-accent);",
        "transform-origin: left center;",
      ]);
      rule(".lo-approve", [
        ...fontCss(ctx, body, 1, 700),
        "display: inline-flex;",
        "align-items: center;",
        `gap: ${px(ctx, 14)};`,
        `padding: ${px(ctx, 18)} ${px(ctx, 44)};`,
        "border-radius: 999px;",
        "background: var(--c-accent);",
        `color: ${inkOnAccent(ctx)};`,
        "white-space: nowrap;",
      ]);
      rule(".lo-approve svg", ["width: 1.05em;", "height: 1.05em;", "opacity: 0;"]);
      const time = layout.duration ? `<span>${escapeHtml(layout.duration)}</span>` : "";
      return done(
        `<div class="lo lo-player"><div class="lo-frame"><div class="lo-screen"><div class="lo-play">${PLAY_SVG}</div><div class="lo-ptitle">${escapeHtml(layout.title)}</div></div><div class="lo-bar2"><span class="lo-track"><span class="lo-prog"></span></span>${time}</div></div><div class="lo-approve">${CHECK_SVG}<span>${escapeHtml(layout.action ?? words.approve)}</span></div></div>`,
      );
    }
    case "meter": {
      const words = uiWords(ctx.language);
      const meterWidth = Math.round(width * (portrait(ctx) ? 0.94 : 0.7));
      const unit = layout.unit ? ` ${layout.unit}` : "";
      const figure = `${amount(layout.used, ctx.language)} / ${amount(layout.cap, ctx.language)}${unit}`;
      const pct = Math.round((layout.used / layout.cap) * 1000) / 10;
      rule(".lo-meter", [
        `width: ${meterWidth}px;`,
        "display: flex;",
        "flex-direction: column;",
        `gap: ${px(ctx, 20)};`,
        "text-align: left;",
      ]);
      rule(".lo-mhead", [
        "display: flex;",
        "align-items: baseline;",
        "justify-content: space-between;",
        `gap: ${px(ctx, 24)};`,
      ]);
      rule(".lo-mlabel", [...fontCss(ctx, body, 1, 600), "min-width: 0;", "overflow-wrap: anywhere;"]);
      rule(".lo-mfig", [
        ...fontCss(
          ctx,
          TEXT_STYLES.heading,
          fitFactor(ctx, TEXT_STYLES.heading, 0.9, figure.length, meterWidth * 0.6),
          700,
        ),
        "white-space: nowrap;",
        "font-variant-numeric: tabular-nums;",
      ]);
      rule(".lo-mtrack", [
        "position: relative;",
        `height: ${px(ctx, 44)};`,
        "border-radius: 999px;",
        `background: ${tint("foreground", 12)};`,
        `box-shadow: inset 0 0 0 ${px(ctx, 3)} ${tint("foreground", 18)};`,
        "overflow: hidden;",
      ]);
      rule(".lo-mfill", [
        "position: absolute;",
        "left: 0;",
        "top: 0;",
        "bottom: 0;",
        `width: ${pct}%;`,
        "border-radius: 999px;",
        "background: var(--c-accent);",
        "transform-origin: left center;",
      ]);
      rule(".lo-mfoot", [
        ...fontCss(ctx, TEXT_STYLES.caption, 0.85, 600),
        "display: flex;",
        "justify-content: space-between;",
        "opacity: 0.75;",
      ]);
      const label = layout.label
        ? `<span class="lo-mlabel">${escapeHtml(layout.label)}</span>`
        : "<span></span>";
      return done(
        `<div class="lo lo-meter"><div class="lo-mhead">${label}<span class="lo-mfig">${escapeHtml(figure)}</span></div><div class="lo-mtrack"><div class="lo-mfill"></div></div><div class="lo-mfoot"><span>${escapeHtml(`${Math.round(pct)}%`)}</span><span>${escapeHtml(`${words.cap} ${amount(layout.cap, ctx.language)}${unit}`)}</span></div></div>`,
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
      // Each message gets a share of the build: a user message the time it takes to type, a reply a beat.
      const plan = layout.messages.map((m) =>
        m.from === "user"
          ? { chunks: typingChunks(m.text, TYPING_STEPS).length, ms: 0 }
          : { chunks: 0, ms: 520 },
      );
      for (const p of plan) if (p.chunks > 0) p.ms = 260 + p.chunks * 45;
      const total = plan.reduce((a, p) => a + p.ms, 0);
      const f = Math.min(1, (span * 0.9) / Math.max(1, total));
      let t = begin;
      layout.messages.forEach((m, i) => {
        const p = plan[i] as { chunks: number; ms: number };
        const sel2 = `${sel} .lo-m${i}`;
        if (m.from === "user") {
          upIn(sel2, seconds(t), 300);
          const at = stagger(
            p.chunks,
            t + Math.round(200 * f),
            Math.max(0, Math.round((p.ms - 260) * f)),
            80,
          );
          for (let j = 0; j < p.chunks; j++) w.set(`${sel} .lo-m${i}c${j}`, { opacity: 1 }, at(j));
        } else {
          pop(sel2, seconds(t + Math.round(120 * f)), 380);
        }
        t += Math.round(p.ms * f);
      });
      return;
    }
    case "tool-call": {
      upIn(`${sel} .lo-tool`, seconds(begin));
      const n = layout.args?.length ?? 0;
      const at = stagger(n, begin + 200, Math.floor(span * 0.4), 160);
      for (let i = 0; i < n; i++) {
        w.fromTo(
          `${sel} .lo-a${i}`,
          { clipPath: "inset(0% 100% 0% 0%)" },
          { clipPath: "inset(0% 0% 0% 0%)", duration: dur(320), ease: "power2.out" },
          at(i),
        );
      }
      const doneAt = layout.status === "done" ? begin + Math.floor(span * 0.85) : end;
      // The spinner turns a full circle every 0.8 s while the call runs.
      const spinMs = Math.max(100, doneAt - begin);
      w.fromTo(
        `${sel} .lo-spin`,
        { rotation: 0 },
        { rotation: Math.round((spinMs / 800) * 360), duration: seconds(spinMs), ease: "none" },
        seconds(begin),
      );
      if (layout.status === "done") {
        w.fromTo(
          `${sel} .lo-run`,
          { opacity: 1 },
          { opacity: 0, duration: dur(200), ease: EASE },
          seconds(doneAt),
        );
        pop(`${sel} .lo-ok`, seconds(doneAt), 380);
        if (layout.result) upIn(`${sel} .lo-result`, seconds(doneAt + 160), 380);
      }
      return;
    }
    case "pipeline": {
      const n = layout.steps.length;
      const at = stagger(n, begin, Math.floor(span * 0.7), 320);
      const column = frame.height > frame.width && n > 3;
      layout.steps.forEach((step, i) => {
        pop(`${sel} .lo-p${i} .lo-pmark`, at(i), 380);
        upIn(`${sel} .lo-p${i} .lo-plabel`, at(i) + 0.08, 360);
        const next = layout.steps[i + 1];
        if (next && next.state !== "todo") {
          w.fromTo(
            `${sel} .lo-n${i} .lo-lfill`,
            column ? { scaleY: 0 } : { scaleX: 0 },
            { ...(column ? { scaleY: 1 } : { scaleX: 1 }), duration: dur(300), ease: EASE },
            at(i) + 0.12,
          );
        }
        if (step.state === "active") {
          const from = at(i) + 0.2;
          const spin = `${sel} .lo-p${i} .lo-pspin`;
          w.fromTo(spin, { opacity: 0 }, { opacity: 1, duration: 0.2, ease: EASE }, from);
          const ms = Math.max(100, end - Math.round(from * 1000));
          w.fromTo(
            spin,
            { rotation: 0 },
            { rotation: Math.round((ms / 900) * 360), duration: seconds(ms), ease: "none" },
            from,
          );
        }
      });
      return;
    }
    case "player": {
      upIn(`${sel} .lo-frame`, seconds(begin));
      const play = begin + Math.round(Math.min(400, span * 0.15));
      w.fromTo(
        `${sel} .lo-play`,
        { scale: 1 },
        { scale: 0.85, duration: 0.12, ease: "power2.in" },
        seconds(play),
      );
      w.fromTo(
        `${sel} .lo-play`,
        { opacity: 1 },
        { opacity: 0, duration: dur(260), ease: EASE },
        seconds(play + 120),
      );
      const playMs = Math.max(100, Math.floor(span * 0.55));
      w.fromTo(
        `${sel} .lo-prog`,
        { scaleX: 0 },
        { scaleX: 1, duration: seconds(playMs), ease: "none" },
        seconds(play),
      );
      const button = `${sel} .lo-approve`;
      const shown = play + playMs;
      pop(button, seconds(shown), 420);
      const press = shown + 520;
      if (press + 300 < end) {
        w.fromTo(button, { scale: 1 }, { scale: 0.9, duration: 0.12, ease: "power2.in" }, seconds(press));
        w.fromTo(button, { scale: 0.9 }, { scale: 1, duration: 0.16, ease: EASE }, seconds(press + 120));
        w.fromTo(
          `${button} svg`,
          { opacity: 0 },
          { opacity: 1, duration: 0.2, ease: EASE },
          seconds(press + 120),
        );
      } else {
        w.set(`${button} svg`, { opacity: 1 }, seconds(shown));
      }
      return;
    }
    case "meter": {
      upIn(`${sel} .lo-mhead`, seconds(begin));
      const fillMs = Math.max(100, Math.min(1400, Math.floor(span * 0.8)));
      w.fromTo(
        `${sel} .lo-mfill`,
        { scaleX: 0 },
        { scaleX: 1, duration: seconds(fillMs), ease: "power2.out" },
        seconds(begin + 150),
      );
      upIn(`${sel} .lo-mfoot`, seconds(begin + 250));
      return;
    }
  }
}
