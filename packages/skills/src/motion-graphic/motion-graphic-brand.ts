import { createHash } from "node:crypto";
import { toStudixError } from "@studix/shared";
import { AssetRef, CreativeBrief, HexColor } from "@studix/video-ir";
import type { StageContext, StageDefinition } from "@studix/workflow";
import { z } from "zod";
import { truncateText } from "../vietnamese-safe-text.ts";

export const MG_BRAND_STAGE = "motion-graphic.brand";

/** The brand read from `brief.brandUrl` and `brief.brandLogo`: what the template merges into the brief's brand. */
export const BrandSource = z.object({
  /** The site's own name for the brand. */
  name: z.string().min(1).max(120).optional(),
  /** Brand colours the site declares, most important first; greys, near-white and near-black dropped. */
  colors: z.array(HexColor).min(1).max(4).optional(),
  /** The logo, stored in tenant storage: the uploaded one, else the site's. */
  logo: AssetRef.optional(),
});
export type BrandSource = z.infer<typeof BrandSource>;

/** The brand stage's checkpoint: the brand, and what could not be read (the job goes on without it). */
export const MotionBrandOutput = BrandSource.extend({ warning: z.string().max(500).optional() });
export type MotionBrandOutput = z.infer<typeof MotionBrandOutput>;

/** The brand to merge from a brand-stage checkpoint, or undefined when it read nothing. */
export function brandSourceOf(output: MotionBrandOutput | undefined): BrandSource | undefined {
  if (!output) return undefined;
  const { warning: _warning, ...source } = output;
  return source.name || source.colors || source.logo ? source : undefined;
}

/** The part of a home page read: its <head>, where names, colours and icons live, comes first. */
const MAX_HTML_BYTES = 1_500_000;
/** Time the whole stage may spend on the network, so a slow site cannot hold a free stage for minutes. */
const BRAND_DEADLINE_MS = 30_000;
const MAX_LOGO_BYTES = 2_000_000;
/** Site logo candidates tried before giving up, so a page full of broken icons cannot stall the job. */
const MAX_LOGO_TRIES = 4;
const LOGO_ASSET_ID = "brand-logo";

/** What a brand's home page says about it. */
export interface BrandPage {
  name?: string;
  colors: string[];
  /** Absolute https logo URLs, best first. */
  logoUrls: string[];
}

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };

/** The few HTML entities a name or attribute uses; anything else is left as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (whole, dec, hex, name) => {
    if (name) return ENTITIES[name.toLowerCase()] ?? whole;
    const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

const ATTR = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

/** The longest tag whose attributes are read; a longer one is no brand markup. */
const MAX_TAG_CHARS = 8192;

/**
 * Every `<name ...>` tag of a page from `from` on: its attribute text and where it ends. A linear `indexOf`
 * scan, not a backtracking regex: the page is untrusted, and `<(meta|link)\b([^>]*)>` over a page of
 * unclosed tags costs seconds per 100 KB, blocking the worker. Tags never nest, so the next search starts
 * past the `>` that closed the last one. `lower` is the page lower-cased, so names match in any case.
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
    if (!/[\w-]/.test(lower[at + needle.length] ?? "") && close - at <= MAX_TAG_CHARS)
      yield { attrs: html.slice(at + needle.length, close), end: close + 1 };
    at = lower.indexOf(needle, close + 1);
  }
}

/** The text inside every `<name ...>...</name>` element, with its open tag's attribute text. Linear. */
function* elementsOf(html: string, lower: string, name: string): Generator<{ attrs: string; text: string }> {
  const closer = `</${name}`;
  let from = 0;
  for (;;) {
    const open = openTags(html, lower, name, from).next();
    if (open.done) return;
    const end = lower.indexOf(closer, open.value.end);
    if (end === -1) return;
    yield { attrs: open.value.attrs, text: html.slice(open.value.end, end) };
    from = end + closer.length;
  }
}

/** Every `<meta>` and `<link>` tag of a page, its attribute names lowercased and values decoded. */
function tagsOf(html: string, lower: string): Array<{ tag: "meta" | "link"; attrs: Record<string, string> }> {
  const tags: Array<{ tag: "meta" | "link"; attrs: Record<string, string> }> = [];
  for (const tag of ["meta", "link"] as const) {
    for (const t of openTags(html, lower, tag)) {
      const attrs: Record<string, string> = {};
      for (const a of t.attrs.matchAll(ATTR)) {
        const key = (a[1] ?? "").toLowerCase();
        if (key && !(key in attrs)) attrs[key] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "").trim();
      }
      tags.push({ tag, attrs });
    }
  }
  return tags;
}

const cleanName = (raw: string | undefined): string | undefined => {
  const name = decodeEntities(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return name ? truncateText(name, 120) : undefined;
};

/** `#rrggbb` for a `#rgb`, `#rrggbb[aa]` or `rgb()` colour; undefined for anything else (named colours too). */
export function normalizeColor(raw: string): string | undefined {
  const v = raw.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])[0-9a-f]?$/.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(v);
  if (long) return `#${long[1]}`;
  const rgb = /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\b/.exec(v);
  if (!rgb) return undefined;
  const channels = rgb.slice(1, 4).map(Number);
  if (channels.some((c) => c > 255)) return undefined;
  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Chroma (max - min channel, 0..1) below which a colour reads as white, black or grey: no brand colour. */
const MIN_CHROMA = 0.12;

const vivid = (hex: string) => {
  const ch = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  return Math.max(...ch) - Math.min(...ch) >= MIN_CHROMA;
};

/** The largest edge a `sizes` attribute lists ("any" counts as large); 0 when it lists none. */
const sizeOf = (sizes: string | undefined) =>
  Math.max(
    0,
    ...(sizes ?? "")
      .toLowerCase()
      .split(/\s+/)
      .map((s) => (s === "any" ? 1024 : Number.parseInt(s.split("x")[0] ?? "", 10) || 0)),
  );

/** `logo` values (a URL, or an object with a `url`) anywhere in a JSON-LD value. */
function jsonLdLogos(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) jsonLdLogos(v, out, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const logo of [record.logo].flat()) {
    if (typeof logo === "string") out.push(logo);
    else if (logo && typeof logo === "object" && typeof (logo as { url?: unknown }).url === "string")
      out.push((logo as { url: string }).url);
  }
  for (const [key, v] of Object.entries(record)) if (key !== "logo") jsonLdLogos(v, out, depth + 1);
}

/** Words a title segment names a page by, never a brand ("Home | Acme", "Trang chủ - Acme"). */
const PAGE_WORDS = /^(home|homepage|home page|welcome|trang chủ|trang chu|official site|official website)$/iu;
const letters = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

/**
 * The brand in a page title: the segment that spells the site's host name ("Acme" on acme.com), else the first
 * segment that is not a page word, else none.
 */
function titleName(title: string, baseUrl: string): string | undefined {
  const segments = title
    .split(/\s+[|\-—–·:]\s+/)
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  let host = "";
  try {
    const labels = new URL(baseUrl).hostname.replace(/^www\./, "").split(".");
    host = letters(labels.length > 2 && labels.at(-2)!.length <= 3 ? labels.at(-3)! : (labels[0] ?? ""));
  } catch {
    // No base URL: the host cannot help.
  }
  const byHost = host
    ? (segments.find((t) => letters(t) === host) ?? segments.find((t) => letters(t).includes(host)))
    : undefined;
  return byHost ?? segments.find((t) => !PAGE_WORDS.test(t));
}

/**
 * The brand's name, colours and logo candidates read from its home page by a linear tag scan (no DOM): name from `og:site_name`, else `application-name`, else the title's first segment; colours from
 * `theme-color`, `msapplication-TileColor` and the mask icon; logos (resolved against `baseUrl`, https only)
 * from an SVG icon, the largest apple-touch-icon, `og:logo`, JSON-LD `logo`, then the other icons (no .ico).
 */
export function readBrandPage(html: string, baseUrl: string): BrandPage {
  const lower = html.toLowerCase();
  const tags = tagsOf(html, lower);
  const meta = (key: string) =>
    tags
      .filter((t) => t.tag === "meta" && (t.attrs.property ?? t.attrs.name ?? "").toLowerCase() === key)
      .map((t) => t.attrs.content ?? "")
      .filter(Boolean);
  const links = tags
    .filter((t) => t.tag === "link" && t.attrs.href)
    .map((t) => ({
      rel: (t.attrs.rel ?? "").toLowerCase().split(/\s+/),
      href: t.attrs.href as string,
      type: (t.attrs.type ?? "").toLowerCase(),
      size: sizeOf(t.attrs.sizes),
      color: t.attrs.color,
    }));
  const title = elementsOf(html, lower, "title").next().value?.text.slice(0, 1000);
  const name =
    cleanName(meta("og:site_name")[0]) ??
    cleanName(meta("application-name")[0]) ??
    cleanName(titleName(decodeEntities(title ?? ""), baseUrl));

  const colors = [
    ...meta("theme-color"),
    ...meta("msapplication-tilecolor"),
    ...links.filter((l) => l.rel.includes("mask-icon")).map((l) => l.color ?? ""),
  ]
    .map(normalizeColor)
    .filter((c): c is string => c !== undefined && vivid(c));

  const icons = links.filter((l) => l.rel.includes("icon"));
  const isSvg = (l: (typeof links)[number]) => l.type === "image/svg+xml" || /\.svg(?:[?#]|$)/i.test(l.href);
  const bySize = (a: { size: number }, b: { size: number }) => b.size - a.size;
  const ldLogos: string[] = [];
  for (const script of elementsOf(html, lower, "script")) {
    if (!/type\s*=\s*["']?application\/ld\+json/i.test(script.attrs)) continue;
    try {
      jsonLdLogos(JSON.parse(script.text), ldLogos);
    } catch {
      // A malformed JSON-LD block is one source fewer, not a failure.
    }
  }
  const candidates = [
    ...icons.filter(isSvg).map((l) => l.href),
    ...links
      .filter((l) => l.rel.some((r) => r.startsWith("apple-touch-icon")))
      .sort(bySize)
      .map((l) => l.href),
    ...meta("og:logo"),
    ...ldLogos,
    ...icons
      .filter((l) => !isSvg(l) && !/\.ico(?:[?#]|$)/i.test(l.href) && l.type !== "image/x-icon")
      .sort(bySize)
      .map((l) => l.href),
  ];
  const logoUrls: string[] = [];
  for (const href of candidates) {
    try {
      const url = new URL(href, baseUrl);
      if (url.protocol === "https:" && !logoUrls.includes(url.toString())) logoUrls.push(url.toString());
    } catch {
      // Not a URL: skipped.
    }
  }
  return { ...(name ? { name } : {}), colors: [...new Set(colors)].slice(0, 4), logoUrls };
}

/** The image types a logo may be, told apart by their bytes, never by a declared type. */
export function sniffLogo(bytes: Uint8Array): { mime: string; ext: string } | undefined {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47])) return { mime: "image/png", ext: "png" };
  if (starts([0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg" };
  if (starts([0x47, 0x49, 0x46, 0x38])) return { mime: "image/gif", ext: "gif" };
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8))
    return { mime: "image/webp", ext: "webp" };
  // An SVG document starts with its <svg> root, after at most a BOM, an XML declaration, comments and a doctype;
  // an HTML page that only contains an inline <svg> (a soft 404) is no logo.
  const head = new TextDecoder()
    .decode(bytes.subarray(0, 4096))
    .replace(/^\uFEFF/, "")
    .replace(/^(?:\s|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/i, "");
  if (/^<svg[\s>]/i.test(head)) return { mime: "image/svg+xml", ext: "svg" };
  return undefined;
}

/** Longest edge of a raster logo: a 4096 px square decodes to 64 MB, which every render frame holds. */
const MAX_LOGO_EDGE = 4096;

/** Pixel size a PNG, JPEG, WebP or GIF declares in its header; undefined when it cannot be read. */
export function rasterSize(bytes: Uint8Array, mime: string): { width: number; height: number } | undefined {
  const at = (i: number) => bytes[i] ?? 0;
  const u16be = (i: number) => (at(i) << 8) | at(i + 1);
  const u16le = (i: number) => at(i) | (at(i + 1) << 8);
  const u24le = (i: number) => at(i) | (at(i + 1) << 8) | (at(i + 2) << 16);
  const u32be = (i: number) => ((at(i) << 24) | (at(i + 1) << 16) | (at(i + 2) << 8) | at(i + 3)) >>> 0;
  if (mime === "image/png") return { width: u32be(16), height: u32be(20) };
  if (mime === "image/gif") return { width: u16le(6), height: u16le(8) };
  if (mime === "image/webp") {
    const chunk = String.fromCharCode(at(12), at(13), at(14), at(15));
    if (chunk === "VP8 ") return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (chunk === "VP8L")
      return {
        width: 1 + (((at(22) & 0x3f) << 8) | at(21)),
        height: 1 + (((at(24) & 0xf) << 10) | (at(23) << 2) | (at(22) >> 6)),
      };
    if (chunk === "VP8X") return { width: 1 + u24le(24), height: 1 + u24le(27) };
    return undefined;
  }
  if (mime === "image/jpeg") {
    // Walk the segments to the first start-of-frame marker, which holds the size.
    for (let i = 2; i + 9 < bytes.length; i += 2 + u16be(i + 2)) {
      if (at(i) !== 0xff) return undefined;
      const marker = at(i + 1);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { width: u16be(i + 7), height: u16be(i + 5) };
    }
  }
  return undefined;
}

/**
 * Why logo bytes must not be stored, or undefined when they may. An SVG that carries script (also namespaced,
 * `<x:script>`), `foreignObject`, event handlers or `javascript:`, or loads anything from outside (an href, a
 * CSS `@import` or `url(...)`), is refused: the stored file must be safe wherever it is served. A raster whose
 * header declares an edge over 4096 px is refused: a small compressed file can decode to gigabytes.
 */
export function logoProblem(bytes: Uint8Array, mime: string): string | undefined {
  if (mime === "image/svg+xml") {
    const text = new TextDecoder().decode(bytes);
    const unsafe =
      /<(?:[\w-]+:)?(?:script|foreignObject)\b|\son[a-z]+\s*=|javascript:|@import|url\(\s*["']?\s*(?!#|data:image\/)|(?:xlink:)?href\s*=\s*["']\s*(?!#|data:image\/)/i;
    return unsafe.test(text) ? "the SVG carries scripts or external references" : undefined;
  }
  const size = rasterSize(bytes, mime);
  if (size && Math.max(size.width, size.height) > MAX_LOGO_EDGE)
    return `it is ${size.width}x${size.height} px; its longest edge may be ${MAX_LOGO_EDGE} px`;
  return undefined;
}

/** Rethrows when the job was aborted, so an abort is never swallowed as a warning. */
function abortedBy(s: StageContext, err: unknown): void {
  if (s.signal.aborted) throw s.signal.reason ?? err;
}

const reasonOf = (err: unknown) => toStudixError(err).message.replace(/\.$/, "");

/** The bytes of a logo source (a base64 data URL or an https URL), or why they could not be read. */
async function logoBytes(
  s: StageContext,
  source: string,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; sourceUrl?: string } | { error: string }> {
  const data = /^data:image\/[a-z0-9.+-]+;base64,(.*)$/i.exec(source);
  if (data) return { bytes: new Uint8Array(Buffer.from(data[1] ?? "", "base64")) };
  if (!s.services.fetchPublic) return { error: "this worker cannot fetch public URLs" };
  try {
    const res = await s.services.fetchPublic(source, { maxBytes: MAX_LOGO_BYTES }, signal);
    if (/html/.test(res.contentType)) return { error: "it is a web page, not an image" };
    return { bytes: res.body, sourceUrl: res.url };
  } catch (err) {
    abortedBy(s, err);
    return { error: reasonOf(err) };
  }
}

/** The first source that is a real image, stored under the job as the brand logo asset. */
async function storeLogo(
  s: StageContext,
  sources: readonly string[],
  signal: AbortSignal,
): Promise<{ logo?: AssetRef; error?: string }> {
  const storage = s.services.storage;
  if (!storage) return { error: "no storage is configured" };
  let error: string | undefined;
  for (const source of sources) {
    const read = await logoBytes(s, source, signal);
    if ("error" in read) {
      error ??= read.error;
      continue;
    }
    const type = sniffLogo(read.bytes);
    if (!type) {
      error ??= "it is not a PNG, JPEG, WebP, GIF or SVG image";
      continue;
    }
    const problem = logoProblem(read.bytes, type.mime);
    if (problem) {
      error ??= problem;
      continue;
    }
    const sha256 = createHash("sha256").update(read.bytes).digest("hex");
    const stored = await storage.put(s.ctx, `brand/${s.job.id}/logo.${type.ext}`, read.bytes, {
      contentType: type.mime,
      sha256,
    });
    const logo = AssetRef.parse({
      id: LOGO_ASSET_ID,
      kind: "image",
      storageKey: stored.key,
      sha256: stored.sha256,
      mime: type.mime,
      bytes: stored.bytes,
      provenance: { source: "brand", ...(read.sourceUrl ? { sourceUrl: read.sourceUrl } : {}) },
    });
    return { logo };
  }
  return error ? { error } : {};
}

const BrandInput = z.object({ outputs: z.object({ brief: z.object({ brief: CreativeBrief }) }) });
type BrandInput = z.infer<typeof BrandInput>;

/**
 * The brand of `brief.brandUrl` and `brief.brandLogo`: the site's name, colours and logo, and the uploaded logo
 * (which wins over the site's), stored as the `brand-logo` asset. Free. A site or logo that cannot be read
 * never fails the job: the stage goes on without it and says why in its `warning`. A brief with neither
 * returns at once, without any network call.
 */
export const motionGraphicBrandStage: StageDefinition = {
  name: MG_BRAND_STAGE,
  inputSchema: BrandInput,
  outputSchema: MotionBrandOutput,
  async run(s) {
    const { brief } = (s.input as BrandInput).outputs.brief;
    if (!brief.brandUrl && !brief.brandLogo) return { output: {} };
    const warnings: string[] = [];
    // The job's own abort still aborts (abortedBy); running out of the deadline only ends the reading.
    const signal = AbortSignal.any([s.signal, AbortSignal.timeout(BRAND_DEADLINE_MS)]);
    let page: BrandPage | undefined;
    if (brief.brandUrl) {
      if (!s.services.fetchPublic) {
        warnings.push(`The brand site ${brief.brandUrl} was not read: this worker cannot fetch public URLs.`);
      } else {
        try {
          const res = await s.services.fetchPublic(
            brief.brandUrl,
            { maxBytes: MAX_HTML_BYTES, truncate: true },
            signal,
          );
          if (res.contentType && !/html|xml/.test(res.contentType)) {
            warnings.push(`The brand site ${brief.brandUrl} is not an HTML page (${res.contentType}).`);
          } else {
            page = readBrandPage(new TextDecoder().decode(res.body), res.url);
          }
        } catch (err) {
          abortedBy(s, err);
          warnings.push(`The brand site ${brief.brandUrl} could not be read: ${reasonOf(err)}.`);
        }
      }
    }
    let logo: AssetRef | undefined;
    if (brief.brandLogo) {
      const uploaded = await storeLogo(s, [brief.brandLogo], signal);
      logo = uploaded.logo;
      if (!logo) warnings.push(`The uploaded logo could not be used: ${uploaded.error ?? "unknown reason"}.`);
    }
    if (!logo && page) {
      const site = await storeLogo(s, page.logoUrls.slice(0, MAX_LOGO_TRIES), signal);
      logo = site.logo;
      if (!logo)
        warnings.push(
          site.error
            ? `No logo of the brand site could be used: ${site.error}.`
            : "The brand site names no logo.",
        );
    }
    return {
      output: MotionBrandOutput.parse({
        ...(page?.name ? { name: page.name } : {}),
        ...(page && page.colors.length > 0 ? { colors: page.colors } : {}),
        ...(logo ? { logo } : {}),
        ...(warnings.length > 0 ? { warning: truncateText(warnings.join(" "), 500) } : {}),
      }),
    };
  },
};
