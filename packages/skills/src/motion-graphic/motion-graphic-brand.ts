import { createHash } from "node:crypto";
import { StudixError, toStudixError } from "@studix/shared";
import { AssetRef, CreativeBrief, HexColor } from "@studix/video-ir";
import type { StageContext, StageDefinition } from "@studix/workflow";
import { z } from "zod";
import { truncateText } from "../vietnamese-safe-text.ts";

export const MG_BRAND_STAGE = "motion-graphic.brand";
/** IR asset id of the logo the brand stage stores. */
export const BRAND_LOGO_ASSET_ID = "brand-logo";

const MAX_PAGE_BYTES = 2_000_000;
const MAX_LOGO_BYTES = 1_500_000;
/** Longest edge of a raster logo: a 4096 px square decodes to 64 MB, which every render frame holds. */
const MAX_LOGO_EDGE = 4096;
/** Logo candidates of a page tried before giving up on a logo. */
const MAX_LOGO_TRIES = 3;

/** What the brand stage found: the brand's name, colours (main first) and its stored logo. */
export const BrandFound = z.object({
  name: z.string().min(1).max(120).optional(),
  colors: z.array(HexColor).max(4).optional(),
  logo: AssetRef.optional(),
});
export type BrandFound = z.infer<typeof BrandFound>;

export const BrandStageOutput = z.object({
  brand: BrandFound,
  warning: z.string().max(500).optional(),
});
export type BrandStageOutput = z.infer<typeof BrandStageOutput>;

/** What a brand's page says about it: its name, theme colours and logo URLs, best first. */
export interface BrandPage {
  name?: string;
  colors: string[];
  logos: string[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** The longest tag whose attributes are read; a longer one is no brand markup. */
const MAX_TAG_CHARS = 8192;

/**
 * Every `<name ...>` tag of the page, with its attribute text and where the tag ends. A linear scan with
 * `indexOf`, not a backtracking regex: the page is untrusted and a crafted one must not hold the worker.
 * Tags never nest, so the next search starts past the `>` that closed the last one. `lower` is `html`
 * lower-cased, so tag names match case-insensitively.
 */
function* openTags(
  html: string,
  lower: string,
  name: string,
  from = 0,
): Generator<{ attrs: string; end: number }> {
  const needle = `<${name}`;
  let at = lower.indexOf(needle, from);
  while (at !== -1) {
    const close = lower.indexOf(">", at + needle.length);
    if (close === -1) return;
    const next = lower[at + needle.length] ?? "";
    if (!/[\w-]/.test(next) && close - at <= MAX_TAG_CHARS)
      yield { attrs: html.slice(at + needle.length, close), end: close + 1 };
    at = lower.indexOf(needle, close + 1);
  }
}

/** The text inside every `<name ...>...</name>` element, with its open tag's attribute text. Linear. */
function* elements(html: string, lower: string, name: string): Generator<{ attrs: string; text: string }> {
  const closer = `</${name}`;
  let from = 0;
  while (from < lower.length) {
    const open = openTags(html, lower, name, from).next();
    if (open.done) return;
    const start = open.value.end;
    const end = lower.indexOf(closer, start);
    if (end === -1) return;
    yield { attrs: open.value.attrs, text: html.slice(start, end) };
    from = end + closer.length;
  }
}

/** Attributes of every `<name ...>` tag in the page, names lower-cased, values entity-decoded. */
function tags(html: string, lower: string, name: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  for (const tag of openTags(html, lower, name)) {
    const attrs: Record<string, string> = {};
    // Bounded name: a long run of name characters with no `=` must not backtrack quadratically.
    for (const a of tag.attrs.matchAll(
      /([a-zA-Z_:][-\w:.]{0,63})\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g,
    )) {
      attrs[(a[1] as string).toLowerCase()] = decodeEntities(a[3] ?? a[4] ?? a[5] ?? "").trim();
    }
    out.push(attrs);
  }
  return out;
}

/** `#rgb` or `#rrggbb` as lower-case `#rrggbb`; anything else is undefined. */
export function hexColor(value: string | undefined): string | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) return undefined;
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join("")}`;
  return undefined;
}

/** A colour that can carry a brand: not near white, near black or grey. */
function brandish(hex: string): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * light - 1));
  return sat >= 0.25 && light >= 0.12 && light <= 0.9;
}

/** The brand name in a page title: its first part before a separator ("Studix | AI video" -> "Studix"). */
function nameFromTitle(title: string): string | undefined {
  const parts = title
    .split(/\s+[|·•—–-]\s+|\s*:\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const first = parts[0];
  return first && first.length <= 40 ? first : undefined;
}

/** Every `logo` value in a JSON-LD document (a URL string, or an ImageObject's `url`). */
function jsonLdLogos(node: unknown, out: string[], depth = 0): void {
  if (depth > 6 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) jsonLdLogos(item, out, depth + 1);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "logo") {
      if (typeof value === "string") out.push(value);
      else if (value && typeof value === "object" && typeof (value as { url?: unknown }).url === "string")
        out.push((value as { url: string }).url);
    } else jsonLdLogos(value, out, depth + 1);
  }
}

/** Largest edge a `sizes` attribute declares ("180x180" -> 180; "any" counts as large). */
function declaredSize(sizes: string | undefined): number {
  if (!sizes) return 0;
  if (/\bany\b/i.test(sizes)) return 512;
  return Math.max(0, ...[...sizes.matchAll(/(\d+)x(\d+)/gi)].map((m) => Number(m[1])));
}

/**
 * Reads a brand's home page: its name (`og:site_name`, `application-name`, else the title's first part),
 * colours (`theme-color` and friends, then `--brand`/`--primary`/`--accent` custom properties in inline
 * styles; greys, near-white and near-black dropped) and logo URLs, best first (the largest touch icon, which
 * is square and opaque so it reads on any card, then JSON-LD `logo`, an `<img>` named logo, a large or SVG
 * icon), resolved against the page URL. Pure.
 */
export function parseBrandPage(html: string, pageUrl: string): BrandPage {
  const head = html.slice(0, 600_000);
  const lower = head.toLowerCase();
  const metas = tags(head, lower, "meta");
  const meta = (key: string) =>
    metas.find((m) => (m.property ?? m.name ?? "").toLowerCase() === key)?.content?.trim() || undefined;
  const title = elements(head, lower, "title").next().value?.text.slice(0, 400);
  const rawName =
    meta("og:site_name") ??
    meta("application-name") ??
    meta("apple-mobile-web-app-title") ??
    (title ? nameFromTitle(decodeEntities(title).replace(/\s+/g, " ").trim()) : undefined);
  const name = rawName ? truncateText(rawName.replace(/\s+/g, " ").trim(), 120) : undefined;

  const links = tags(head, lower, "link");
  const colors: string[] = [];
  const addColor = (value: string | undefined) => {
    const hex = hexColor(value);
    if (hex && brandish(hex) && !colors.includes(hex)) colors.push(hex);
  };
  for (const m of metas) {
    const key = (m.name ?? m.property ?? "").toLowerCase();
    if (key === "theme-color" || key === "msapplication-tilecolor" || key === "msapplication-navbutton-color")
      addColor(m.content);
  }
  for (const l of links) if ((l.rel ?? "").toLowerCase().includes("mask-icon")) addColor(l.color);
  for (const style of elements(head, lower, "style")) {
    for (const m of style.text.matchAll(/(--[\w-]{1,64})\s*:\s*(#[0-9a-f]{3,6})\b/gi))
      if (/brand|primary|accent/i.test(m[1] as string)) addColor(m[2]);
  }

  const resolve = (href: string | undefined) => {
    if (!href || href.startsWith("data:")) return undefined;
    try {
      const url = new URL(href, pageUrl);
      return url.protocol === "https:" ? url.toString() : undefined;
    } catch {
      return undefined;
    }
  };
  const logos: string[] = [];
  const addLogo = (href: string | undefined) => {
    const url = resolve(href);
    if (url && !logos.includes(url)) logos.push(url);
  };
  const icons = links
    .map((l) => ({
      rel: (l.rel ?? "").toLowerCase(),
      href: l.href,
      size: declaredSize(l.sizes),
      type: l.type,
    }))
    .filter((l) => l.href);
  const touch = icons.filter((l) => l.rel.includes("apple-touch-icon")).sort((a, b) => b.size - a.size);
  for (const t of touch) addLogo(t.href);
  for (const script of elements(head, lower, "script")) {
    if (!script.attrs.toLowerCase().includes("application/ld+json")) continue;
    try {
      const found: string[] = [];
      jsonLdLogos(JSON.parse(script.text), found);
      for (const f of found) addLogo(f);
    } catch {
      // A malformed JSON-LD block says nothing about the logo.
    }
  }
  const img = tags(head, lower, "img").find((i) =>
    [i.class, i.id, i.alt, i.src].some((v) => v !== undefined && /logo/i.test(v)),
  );
  addLogo(img?.src ?? img?.["data-src"]);
  const icon = icons
    .filter((l) => /(^|\s)icon(\s|$)/.test(l.rel) && (l.type === "image/svg+xml" || l.size >= 96))
    .sort((a, b) => b.size - a.size);
  for (const i of icon) addLogo(i.href);
  addLogo(meta("og:logo"));
  return { ...(name ? { name } : {}), colors: colors.slice(0, 4), logos };
}

/** Media type, file extension and pixel size of an image, read from its bytes; undefined when not one. */
export function imageInfo(
  bytes: Uint8Array,
): { mime: string; ext: string; width?: number; height?: number } | undefined {
  const at = (i: number) => bytes[i] ?? 0;
  const u16be = (i: number) => (at(i) << 8) | at(i + 1);
  const u32be = (i: number) => ((at(i) << 24) | (at(i + 1) << 16) | (at(i + 2) << 8) | at(i + 3)) >>> 0;
  const ascii = (i: number, n: number) => String.fromCharCode(...bytes.subarray(i, i + n));
  const sized = (mime: string, ext: string, width: number, height: number) =>
    width > 0 && height > 0 ? { mime, ext, width, height } : { mime, ext };
  if (at(0) === 0x89 && ascii(1, 3) === "PNG") return sized("image/png", ".png", u32be(16), u32be(20));
  if (at(0) === 0xff && at(1) === 0xd8) {
    for (let i = 2; i + 9 < bytes.length; ) {
      if (at(i) !== 0xff) return { mime: "image/jpeg", ext: ".jpg" };
      const marker = at(i + 1);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return sized("image/jpeg", ".jpg", u16be(i + 7), u16be(i + 5));
      i += 2 + u16be(i + 2);
    }
    return { mime: "image/jpeg", ext: ".jpg" };
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8 ")
      return sized("image/webp", ".webp", u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
    if (chunk === "VP8L") {
      const b = (i: number) => at(21 + i);
      return sized(
        "image/webp",
        ".webp",
        1 + (((b(1) & 0x3f) << 8) | b(0)),
        1 + (((b(3) & 0xf) << 10) | (b(2) << 2) | (b(1) >> 6)),
      );
    }
    if (chunk === "VP8X") return sized("image/webp", ".webp", 1 + u24le(bytes, 24), 1 + u24le(bytes, 27));
    return { mime: "image/webp", ext: ".webp" };
  }
  if (ascii(0, 4) === "GIF8") return sized("image/gif", ".gif", u16le(bytes, 6), u16le(bytes, 8));
  const text = new TextDecoder().decode(bytes.subarray(0, 4096)).replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg\b/i.test(text)) {
    const svg = /<svg\b[^>]*>/i.exec(text)?.[0] ?? "";
    const viewBox = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(svg);
    const w = /\swidth\s*=\s*["']([\d.]+)(px)?["']/i.exec(svg);
    const h = /\sheight\s*=\s*["']([\d.]+)(px)?["']/i.exec(svg);
    const width = Math.round(Number(viewBox?.[1] ?? w?.[1] ?? 0));
    const height = Math.round(Number(viewBox?.[2] ?? h?.[1] ?? 0));
    return sized("image/svg+xml", ".svg", width, height);
  }
  return undefined;
}

function u16le(bytes: Uint8Array, i: number): number {
  return (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8);
}
function u24le(bytes: Uint8Array, i: number): number {
  return (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8) | ((bytes[i + 2] ?? 0) << 16);
}

/**
 * An SVG that carries script (also namespaced, `<x:script>`) or event handlers, or loads anything from outside
 * (an href, a CSS `@import` or `url(...)`), is refused as a logo.
 */
function unsafeSvg(bytes: Uint8Array): boolean {
  const text = new TextDecoder().decode(bytes);
  return /<(?:[\w-]+:)?(?:script|foreignObject)\b|\son[a-z]+\s*=|javascript:|@import|url\(\s*["']?\s*(?!#|data:image\/)|(?:xlink:)?href\s*=\s*["']\s*(?!#|data:image\/)/i.test(
    text,
  );
}

const BriefOutputs = z.object({ outputs: z.object({ brief: z.object({ brief: CreativeBrief }) }) });

/** Whether a brief asks for anything the brand stage reads. */
export const wantsBrandKit = (brief: CreativeBrief) =>
  Boolean(brief.brandUrl || brief.brandLogo || brief.brandColors?.length);

interface LogoBytes {
  bytes: Uint8Array;
  sourceUrl?: string;
}

/** The logo the brief supplies: a data URL is decoded, an https URL is read through the web fetcher. */
async function suppliedLogo(s: StageContext, logo: string): Promise<LogoBytes> {
  if (logo.startsWith("data:")) {
    const base64 = logo.slice(logo.indexOf(",") + 1);
    return { bytes: new Uint8Array(Buffer.from(base64, "base64")) };
  }
  const web = s.services.web;
  if (!web) throw new StudixError("UNAVAILABLE", "this worker cannot read web pages");
  const res = await web.get(logo, { maxBytes: MAX_LOGO_BYTES, accept: "image/*", signal: s.signal });
  return { bytes: res.body, sourceUrl: res.url };
}

/** Store logo bytes as the graphic's brand logo asset; undefined (with a reason) when they are no usable image. */
async function storeLogo(s: StageContext, logo: LogoBytes): Promise<AssetRef> {
  const info = imageInfo(logo.bytes);
  if (!info) throw new StudixError("VALIDATION", "the logo is not a PNG, JPEG, WebP, GIF or SVG image");
  if (logo.bytes.byteLength > MAX_LOGO_BYTES)
    throw new StudixError("VALIDATION", `the logo is larger than ${MAX_LOGO_BYTES} bytes`);
  // A small compressed image can declare a huge canvas that the renderer would decode on every frame.
  if (
    info.width &&
    info.height &&
    info.mime !== "image/svg+xml" &&
    Math.max(info.width, info.height) > MAX_LOGO_EDGE
  )
    throw new StudixError(
      "VALIDATION",
      `the logo is ${info.width}x${info.height}; its longest edge may be ${MAX_LOGO_EDGE}px`,
    );
  if (info.mime === "image/svg+xml" && unsafeSvg(logo.bytes))
    throw new StudixError("VALIDATION", "the SVG logo carries scripts or external references");
  const storage = s.services.storage;
  if (!storage) throw new StudixError("UNAVAILABLE", "this worker has no storage");
  const sha256 = createHash("sha256").update(logo.bytes).digest("hex");
  const stored = await storage.put(
    s.ctx,
    `generated/${s.job.id}/brand-logo-${sha256.slice(0, 12)}${info.ext}`,
    logo.bytes,
    {
      contentType: info.mime,
      sha256,
    },
  );
  return {
    id: BRAND_LOGO_ASSET_ID,
    kind: "image",
    storageKey: stored.key,
    sha256: stored.sha256,
    mime: info.mime,
    bytes: logo.bytes.byteLength,
    ...(info.width ? { width: info.width, height: info.height } : {}),
    provenance: {
      source: logo.sourceUrl ? "brand" : "upload",
      ...(logo.sourceUrl ? { sourceUrl: logo.sourceUrl } : {}),
    },
  };
}

/**
 * The brand kit of a brief that gives `brandUrl`, `brandLogo` or `brandColors`: reads the brand's page for
 * its name, colours and logo (the brief's own logo and colours win), and stores the logo in the tenant's
 * storage as the `brand-logo` IR asset. Free. A page or logo that cannot be read never fails the job: what was
 * found is kept and the stage reports a `warning`.
 */
export const motionGraphicBrandStage: StageDefinition = {
  name: MG_BRAND_STAGE,
  inputSchema: BriefOutputs,
  outputSchema: BrandStageOutput,
  async run(s) {
    const { brief } = (s.input as z.infer<typeof BriefOutputs>).outputs.brief;
    if (!wantsBrandKit(brief)) return { output: { brand: {} } };
    const problems: string[] = [];
    let page: BrandPage | undefined;
    if (brief.brandUrl) {
      if (!s.services.web) problems.push("brandUrl was not read: this worker cannot read web pages");
      else {
        try {
          const res = await s.services.web.get(brief.brandUrl, {
            maxBytes: MAX_PAGE_BYTES,
            accept: "text/html,application/xhtml+xml",
            signal: s.signal,
          });
          page = parseBrandPage(new TextDecoder().decode(res.body), res.url);
        } catch (err) {
          if (s.signal.aborted) throw err;
          problems.push(`brandUrl was not read: ${toStudixError(err).message}`);
        }
      }
    }
    let logo: AssetRef | undefined;
    if (brief.brandLogo) {
      try {
        logo = await storeLogo(s, await suppliedLogo(s, brief.brandLogo));
      } catch (err) {
        if (s.signal.aborted) throw err;
        problems.push(`brandLogo was not used: ${toStudixError(err).message}`);
      }
    }
    if (!logo && page && s.services.web) {
      for (const url of page.logos.slice(0, MAX_LOGO_TRIES)) {
        try {
          const res = await s.services.web.get(url, {
            maxBytes: MAX_LOGO_BYTES,
            accept: "image/*",
            signal: s.signal,
          });
          logo = await storeLogo(s, { bytes: res.body, sourceUrl: res.url });
          break;
        } catch (err) {
          if (s.signal.aborted) throw err;
        }
      }
      if (!logo) problems.push("no usable logo was found at brandUrl");
    }
    const colors = brief.brandColors?.length ? brief.brandColors.map((c) => c.toLowerCase()) : page?.colors;
    const found: BrandFound = {
      ...(page?.name ? { name: page.name } : {}),
      ...(colors?.length ? { colors: colors.slice(0, 4) } : {}),
      ...(logo ? { logo } : {}),
    };
    return {
      output: {
        brand: found,
        ...(problems.length > 0 ? { warning: truncateText(problems.join("; "), 500) } : {}),
      },
    };
  },
};
