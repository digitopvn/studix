import { StudixError } from "@studix/shared";
import type { BrandKit, ColorRole, Shot, ShotStyle, TextStyleRole } from "@studix/video-ir";
import { COLOR_ROLES, cssColor, type FontSlot, TEXT_STYLES } from "./brand-tokens.ts";
import { prepareHero, scopeCss } from "./hero-html.ts";
import { cssRule, escapeHtml, num, seconds } from "./html-utils.ts";
import { renderLayoutMarkup } from "./layout-markup.ts";

/** What a shot renderer needs to know about the scene being compiled. */
export interface ShotMarkupContext {
  /** Id prefix unique per scene, so ids never collide once compositions are mounted together. */
  prefix: string;
  /** Type scale factor (short frame edge / 1080). */
  scale: number;
  frame: { width: number; height: number };
  /** CSS font-family stacks per slot. */
  fontStacks: Record<FontSlot, string>;
  /** Weights used per slot; filled while rendering so only needed font files are bundled. */
  fontWeights: Record<FontSlot, Set<number>>;
  /** IR asset id -> project-relative path of the copied file. */
  assetPaths: ReadonlyMap<string, string>;
  brand?: BrandKit;
  /** Resolved scene palette; layouts pick the ink that reads on an accent fill from it. */
  palette?: Record<ColorRole, string>;
  /** IR language (BCP 47), for number formatting in layouts. */
  language?: string;
}

export interface ShotMarkup {
  html: string;
  css: string[];
}

export const shotDomId = (prefix: string, shotId: string): string => `${prefix}shot-${shotId}`;

/** Where a shot sits: its style region, else the middle; an html hero card fills the whole card by default. */
export const shotRegion = (shot: Shot): NonNullable<ShotStyle["region"]> =>
  shot.style?.region ?? (shot.type === "html" ? "full" : "middle");

/** Weights bundled for hero cards, whose CSS may ask for any of them. */
const HERO_WEIGHTS: Record<"heading" | "body", number[]> = { heading: [700, 800], body: [400, 600] };

const EMPHASIS_SCALE = { none: 1, low: 0.88, high: 1.15 } as const;
const TEXT_ALIGN = { start: "left", center: "center", end: "right" } as const;

/**
 * Typography for one text role. Vietnamese is space-separated syllables, so normal word wrapping is
 * correct; automatic hyphenation is disabled because it would split syllables. `pre-line` keeps explicit
 * line breaks chosen by templates, and `text-wrap: balance` avoids single-syllable last lines.
 */
function textCss(ctx: ShotMarkupContext, role: TextStyleRole, style: ShotStyle | undefined): string[] {
  const token = TEXT_STYLES[role];
  ctx.fontWeights[token.font].add(token.weight);
  const size = Math.round(token.sizeAt1080 * ctx.scale * EMPHASIS_SCALE[style?.emphasis ?? "none"]);
  return [
    `font-family: ${ctx.fontStacks[token.font]};`,
    `font-size: ${size}px;`,
    `line-height: ${token.lineHeight};`,
    `font-weight: ${token.weight};`,
    `color: ${cssColor(style?.color ?? "foreground")};`,
    `text-align: ${TEXT_ALIGN[style?.align ?? "center"]};`,
    "white-space: pre-line;",
    "overflow-wrap: break-word;",
    "hyphens: manual;",
    "text-wrap: balance;",
    "max-width: 100%;",
  ];
}

/** Box around a shot when the style asks for a background colour. */
function boxCss(ctx: ShotMarkupContext, style: ShotStyle | undefined): string[] {
  if (!style?.background) return [];
  const pad = Math.round(28 * ctx.scale);
  return [
    `background: ${cssColor(style.background)};`,
    `padding: ${Math.round(pad * 0.6)}px ${pad}px;`,
    `border-radius: ${Math.round(18 * ctx.scale)}px;`,
  ];
}

function imageCss(ctx: ShotMarkupContext, fit: "cover" | "contain", full: boolean): string[] {
  return full
    ? ["display: block;", "width: 100%;", "height: 100%;", `object-fit: ${fit};`]
    : [
        "display: block;",
        "max-width: 100%;",
        `max-height: ${Math.round(ctx.frame.height * 0.45)}px;`,
        `object-fit: ${fit};`,
        `border-radius: ${Math.round(16 * ctx.scale)}px;`,
      ];
}

function assetPath(ctx: ShotMarkupContext, shot: Shot, assetId: string): string {
  const path = ctx.assetPaths.get(assetId);
  if (!path) {
    throw new StudixError(
      "VALIDATION",
      `Shot "${shot.id}" references asset "${assetId}" without a local file`,
      {
        details: { shotId: shot.id, assetId },
        suggestedAction: "Download the asset and pass it in RenderOptions.assetFiles.",
      },
    );
  }
  return path;
}

/**
 * A timed `<video>` clip. HyperFrames extracts its frames with FFmpeg and injects them per captured frame;
 * the start is local to the scene composition (declared explicitly so it is never read as root-global).
 * The browser copy is always muted: clip audio is mixed by the FFmpeg finish, not by the browser.
 */
export function videoClipTag(clip: {
  id: string;
  src: string;
  startMs: number;
  durationMs: number;
  trimStartMs?: number;
  className?: string;
}): string {
  const attrs = [
    `id="${clip.id}"`,
    clip.className ? `class="${clip.className}"` : "",
    `src="${escapeHtml(clip.src)}"`,
    `data-start="${num(seconds(clip.startMs))}"`,
    `data-duration="${num(seconds(clip.durationMs))}"`,
    `data-media-start="${num(seconds(clip.trimStartMs ?? 0))}"`,
    'data-hf-media-start-basis="local"',
    'data-track-index="0"',
    "muted",
    "playsinline",
    'preload="auto"',
  ];
  return `<video ${attrs.filter(Boolean).join(" ")}></video>`;
}

/** HTML and CSS for one shot. The outer element carries the DOM id the timeline animates. */
export function renderShotMarkup(ctx: ShotMarkupContext, shot: Shot): ShotMarkup {
  const id = shotDomId(ctx.prefix, shot.id);
  const sel = `#${id}`;
  const full = shotRegion(shot) === "full";
  const base = ["opacity: 0;", "min-width: 0;", "box-sizing: border-box;", ...boxCss(ctx, shot.style)];
  const open = `<div id="${id}" class="shot shot-${shot.type}">`;

  switch (shot.type) {
    case "title": {
      const css = [
        cssRule(sel, base),
        cssRule(`${sel} .t-main`, textCss(ctx, shot.style?.textStyle ?? "display", shot.style)),
      ];
      let sub = "";
      if (shot.subtitle) {
        css.push(
          cssRule(`${sel} .t-sub`, [
            ...textCss(ctx, "body", { ...shot.style, emphasis: "none" }),
            `margin-top: ${Math.round(18 * ctx.scale)}px;`,
          ]),
        );
        sub = `<div class="t-sub">${escapeHtml(shot.subtitle)}</div>`;
      }
      return { html: `${open}<div class="t-main">${escapeHtml(shot.text)}</div>${sub}</div>`, css };
    }
    case "text":
      return {
        html: `${open}${escapeHtml(shot.text)}</div>`,
        css: [cssRule(sel, [...base, ...textCss(ctx, shot.style?.textStyle ?? "body", shot.style)])],
      };
    case "image": {
      const src = assetPath(ctx, shot, shot.assetId);
      const sizing = full ? ["width: 100%;", "height: 100%;"] : [];
      return {
        html: `${open}<img src="${escapeHtml(src)}" alt="${escapeHtml(shot.alt)}" /></div>`,
        css: [
          cssRule(sel, [...base, ...sizing]),
          cssRule(`${sel} img`, imageCss(ctx, shot.fit ?? "cover", full)),
        ],
      };
    }
    case "logo": {
      // IR rule: explicit asset, else the brand logo, else `text` (or the brand name) as a wordmark.
      const assetId = shot.assetId ?? ctx.brand?.logoAssetId;
      if (assetId) {
        const src = assetPath(ctx, shot, assetId);
        const alt = ctx.brand?.name ?? "logo";
        return {
          html: `${open}<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" /></div>`,
          css: [
            cssRule(sel, base),
            cssRule(`${sel} img`, [
              "display: block;",
              `max-width: ${Math.round(ctx.frame.width * 0.6)}px;`,
              `max-height: ${Math.round(Math.min(ctx.frame.width, ctx.frame.height) * 0.28)}px;`,
              "object-fit: contain;",
            ]),
          ],
        };
      }
      const wordmark = shot.text ?? ctx.brand?.name ?? "";
      return {
        html: `${open}${escapeHtml(wordmark)}</div>`,
        css: [
          cssRule(sel, [
            ...base,
            ...textCss(ctx, shot.style?.textStyle ?? "display", shot.style),
            "letter-spacing: -0.01em;",
          ]),
        ],
      };
    }
    case "cta": {
      const pad = Math.round(30 * ctx.scale);
      const css = [
        cssRule(sel, [
          ...base,
          "display: flex;",
          "flex-direction: column;",
          "align-items: center;",
          `gap: ${Math.round(20 * ctx.scale)}px;`,
        ]),
        cssRule(`${sel} .cta-pill`, [
          ...textCss(ctx, shot.style?.textStyle ?? "heading", shot.style),
          "display: inline-block;",
          `padding: ${Math.round(pad * 0.55)}px ${pad * 1.4}px;`,
          "border-radius: 999px;",
          `border: ${num(Math.max(2, 5 * ctx.scale))}px solid currentColor;`,
        ]),
      ];
      let url = "";
      if (shot.url) {
        css.push(cssRule(`${sel} .cta-url`, textCss(ctx, "caption", { ...shot.style, emphasis: "none" })));
        url = `<div class="cta-url">${escapeHtml(shot.url)}</div>`;
      }
      return { html: `${open}<div class="cta-pill">${escapeHtml(shot.text)}</div>${url}</div>`, css };
    }
    case "composition":
      throw new StudixError(
        "VALIDATION",
        `Composition shot "${shot.id}" is not supported by the HyperFrames renderer`,
        {
          suggestedAction: "Check RendererAdapter.supports() before rendering.",
        },
      );
    case "layout":
      return renderLayoutMarkup(
        ctx,
        sel,
        open,
        base,
        shot.layout,
        cssColor(shot.style?.color ?? "foreground"),
      );
    case "html": {
      // Hero card: the linted fragment inside the shot root; its <style> block is scoped to that root.
      // The brand is exposed as custom properties on the root: colours `var(--color-primary)`,
      // `--color-secondary`, `--color-accent`, `--color-background`, `--color-foreground`, `--color-muted`,
      // and fonts `var(--font-heading)` / `var(--font-body)` (bundled offline at 400/600 body and 700/800
      // heading). Font families named directly in the fragment CSS are not bundled and fall back to the system.
      // The card is authored in pixels of a reference frame whose short edge is 1080 (1920x1080, 1080x1920,
      // 1080x1080) and zoomed to the render size, so a preview render lays it out exactly like the final one.
      const hero = prepareHero(shot.html);
      const stage = `${sel} > .hero-stage`;
      for (const slot of ["heading", "body"] as const)
        for (const weight of HERO_WEIGHTS[slot]) ctx.fontWeights[slot].add(weight);
      const sizing = full ? ["width: 100%;", "height: 100%;"] : ["position: relative;"];
      const vars = [
        ...COLOR_ROLES.map((role) => `--color-${role}: var(--c-${role});`),
        `--font-heading: ${ctx.fontStacks.heading};`,
        `--font-body: ${ctx.fontStacks.body};`,
      ];
      const reference = full
        ? [`width: ${num(ctx.frame.width / ctx.scale)}px;`, `height: ${num(ctx.frame.height / ctx.scale)}px;`]
        : [];
      const css = [
        cssRule(sel, [...base, ...sizing, ...vars]),
        cssRule(stage, [`zoom: ${num(ctx.scale)};`, ...reference]),
      ];
      if (hero.css) css.push(scopeCss(hero.css, stage));
      // The shot stays hidden until its entrance even if the card CSS styles its root.
      css.push(cssRule(sel, ["opacity: 0;"]));
      return { html: `${open}<div class="hero-stage">${hero.html}</div></div>`, css };
    }
    case "video": {
      const src = assetPath(ctx, shot, shot.assetId);
      const sizing = full ? ["width: 100%;", "height: 100%;"] : [];
      const tag = videoClipTag({
        id: `${id}-clip`,
        src,
        startMs: shot.startMs,
        durationMs: shot.durationMs,
        trimStartMs: shot.trimStartMs,
      });
      return {
        html: `${open}${tag}</div>`,
        css: [
          cssRule(sel, [...base, ...sizing]),
          cssRule(`${sel} video`, imageCss(ctx, shot.fit ?? "cover", full)),
        ],
      };
    }
  }
}
