import { createHash } from "node:crypto";
import type { ExternalSkillFileKind } from "@studix/core";

/** Where a file inside a skill folder belongs, or why it is not imported. */
export type SkillFilePlacement = { kind: Exclude<ExternalSkillFileKind, "skill"> } | { skip: string };

export type SkillFileContent = { contentType: string; text: boolean } | { skip: string };

const LICENSE_RE = /^(?:LICENSE|LICENCE|COPYING)(?:\.(?:md|txt))?$/i;
const README_RE = /^README(?:\.(?:md|txt))?$/i;

const TEXT_TYPES: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  csv: "text/csv",
};

const IMAGE_TYPES: Record<string, { contentType: string; matches: (bytes: Uint8Array) => boolean }> = {
  png: { contentType: "image/png", matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  jpg: { contentType: "image/jpeg", matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  jpeg: { contentType: "image/jpeg", matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  gif: { contentType: "image/gif", matches: (b) => startsWith(b, [0x47, 0x49, 0x46, 0x38]) },
  webp: {
    contentType: "image/webp",
    matches: (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && ascii(b, 8, 12) === "WEBP",
  },
};

export const UNSUPPORTED_FILE_TYPE = "unsupported file type";

/** Whether a file name is a license file (`LICENSE`, `LICENSE.md`, `LICENSE.txt`, `COPYING`, ...). */
export function isLicenseFileName(name: string): boolean {
  return LICENSE_RE.test(name);
}

/**
 * Decide the kind of a file from its path relative to the skill folder: `references/` and `assets/`
 * are stored, `scripts/` are listed as metadata only, and a top-level license or README is kept as a
 * reference. Everything else is skipped.
 */
export function placeSkillFile(relativePath: string): SkillFilePlacement {
  const segments = relativePath.split("/");
  const top = segments[0] ?? "";
  if (segments.length > 1) {
    if (top === "references") return { kind: "reference" };
    if (top === "assets") return { kind: "asset" };
    if (top === "scripts") return { kind: "script" };
    return { skip: "outside references/, assets/ and scripts/" };
  }
  if (LICENSE_RE.test(top) || README_RE.test(top)) return { kind: "reference" };
  return { skip: "outside references/, assets/ and scripts/" };
}

/** Type a downloaded file. SVG is an asset that is never treated as inline text. */
export function describeSkillFile(path: string, bytes: Uint8Array, kind: ExternalSkillFileKind): SkillFileContent {
  const ext = extension(path);
  const text = isUtf8Text(bytes);
  if (kind === "script") {
    return { contentType: TEXT_TYPES[ext] ?? (text ? "text/plain" : "application/octet-stream"), text };
  }
  if (ext === "svg") return text ? { contentType: "image/svg+xml", text: false } : { skip: "SVG is not valid text" };
  const image = IMAGE_TYPES[ext];
  if (image) {
    return image.matches(bytes)
      ? { contentType: image.contentType, text: false }
      : { skip: "content does not match its file type" };
  }
  const textType = TEXT_TYPES[ext];
  if (textType) return text ? { contentType: textType, text: true } : { skip: "not valid UTF-8 text" };
  return text ? { contentType: "text/plain", text: true } : { skip: UNSUPPORTED_FILE_TYPE };
}

/** Valid UTF-8 without NUL bytes. */
export function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The git object id of a blob with these bytes (`sha1("blob <size>\0" + bytes)`). */
export function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}
