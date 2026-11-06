import { EXTERNAL_SKILL_LIMITS } from "./limits.ts";

/**
 * True for a `/`-separated repository path that cannot escape its directory: no empty, `.` or `..`
 * segments, no backslashes, NUL or control characters, and within the depth and length bounds.
 */
export function isSafeRepoPath(path: string): boolean {
  if (path.length === 0) return false;
  if (path.length > EXTERNAL_SKILL_LIMITS.maxPathLength) return false;
  if (path.startsWith("/") || path.endsWith("/") || path.includes("\\")) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is being rejected
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  const segments = path.split("/");
  if (segments.length > EXTERNAL_SKILL_LIMITS.maxPathDepth) return false;
  return segments.every((s) => s !== "" && s !== "." && s !== "..");
}

/** Normalize a caller-supplied skill directory: `""`, `.` and `/` mean the repository root. */
export function normalizeSkillDir(input: string): string | undefined {
  const trimmed = input
    .trim()
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "");
  if (trimmed === "" || trimmed === ".") return "";
  return isSafeRepoPath(trimmed) ? trimmed : undefined;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function joinPath(dir: string, rest: string): string {
  return dir === "" ? rest : `${dir}/${rest}`;
}

/** Path of `path` below `dir`, or undefined when it is not inside it. */
export function relativeTo(dir: string, path: string): string | undefined {
  if (dir === "") return path;
  return path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : undefined;
}
