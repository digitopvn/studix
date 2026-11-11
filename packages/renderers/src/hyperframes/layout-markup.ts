import type { ColorRole, LayoutSpec } from "@studix/video-ir";
import { cssColor, TEXT_STYLES, type TextStyleToken } from "./brand-tokens.ts";
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
/**
 * Height a layout may take: what the content area leaves under a headline of up to two lines and above
 * the burned captions, so a tall layout never runs into either.
 */
const layoutHeight = (ctx: ShotMarkupContext) =>
  (ctx.frame.height - 2 * Math.round(0.07 * Math.min(ctx.frame.width, ctx.frame.height))) *
  (portrait(ctx) ? 0.7 : 0.55);

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

/** HTML and CSS for a layout shot; `sel` is the shot's outer element selector. */
export function renderLayoutMarkup(
  ctx: ShotMarkupContext,
  sel: string,
  open: string,
  base: string[],
  layout: LayoutSpec,
  ink: string,
): ShotMarkup {
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
      // the lines (plus the title bar and padding, about 1.6 more) fit the layout's height.
      const sizePx = Math.min(
        Math.round(TEXT_STYLES.body.sizeAt1080 * ctx.scale),
        Math.floor((width * 0.9) / (longest * 0.6)),
        Math.floor(layoutHeight(ctx) / ((layout.lines.length + 1.6) * 1.55)),
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
      // A portrait frame cannot hold four or more chips side by side: they hang off a spine instead.
      const column = portrait(ctx) && n > 3;
      const line = tint("foreground", 45);
      const stroke = px(ctx, 4);
      const pill = [
        `padding: ${px(ctx, 16)} ${px(ctx, 30)};`,
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
        ...fontCss(ctx, body, 1.1, 700),
        ...pill,
        "background: var(--c-accent);",
        `color: ${inkOnAccent(ctx)};`,
      ]);
      rule(".lo-stem", [
        `width: ${stroke};`,
        `height: ${px(ctx, 56)};`,
        `background: ${line};`,
        "transform-origin: top center;",
        column ? `margin-left: ${px(ctx, 40)};` : "",
      ]);
      rule(".lo-row", [
        "position: relative;",
        "display: grid;",
        "width: 100%;",
        column ? "grid-auto-rows: 1fr;" : `grid-template-columns: repeat(${n}, minmax(0, 1fr));`,
        `gap: ${px(ctx, column ? 18 : 20)};`,
        column ? `padding-left: ${px(ctx, 40)};` : "",
        "box-sizing: border-box;",
      ]);
      // The bus runs between the first and last chip's centres, which equal tracks make exact.
      rule(
        ".lo-bus",
        column
          ? [
              "position: absolute;",
              `left: ${px(ctx, 40)};`,
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
              `width: ${px(ctx, 36)};`,
              `height: ${stroke};`,
              `background: ${line};`,
              "flex: 0 0 auto;",
              "transform-origin: left center;",
            ]
          : [
              `width: ${stroke};`,
              `height: ${px(ctx, 44)};`,
              `background: ${line};`,
              "transform-origin: top center;",
            ],
      );
      rule(".lo-chip", [
        ...fontCss(ctx, body, column ? 1 : n > 4 ? 0.75 : 0.9, 600),
        ...pill,
        `border: ${px(ctx, 3)} solid ${tint("foreground", 40)};`,
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
      rule(".lo-ctext", [...fontCss(ctx, body, n > 3 ? 0.85 : 1, 700), "overflow-wrap: anywhere;"]);
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
      const column = frame.height > frame.width && n > 3;
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
        w.fromTo(`${sel} .lo-p${c}`, { opacity: 0 }, show, at);
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
  }
}
