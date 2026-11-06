const MAX_PATH_LENGTH = 1024;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is rejected.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f\\]/;
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/**
 * Normalize a path inside a repository: `""` is the root, otherwise `a/b/c` with no leading slash,
 * trailing slash, empty, `.` or `..` segment, backslash or control character. Returns `undefined` for
 * any unsafe path so callers can reject it individually.
 */
export function normalizeRepoPath(path: string): string | undefined {
  if (typeof path !== "string" || path.length > MAX_PATH_LENGTH || UNSAFE_CHARS.test(path)) return undefined;
  if (path.startsWith("/")) return undefined;
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "" || trimmed === ".") return "";
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "" || DOT_SEGMENT.test(segment))) return undefined;
  return segments.join("/");
}

export function pathDepth(path: string): number {
  return path === "" ? 0 : path.split("/").length;
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function dirName(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

/** True when `path` is `dir` itself or lies below it; the root `""` contains everything. */
export function isWithin(path: string, dir: string): boolean {
  return dir === "" || path === dir || path.startsWith(`${dir}/`);
}

/** How a skill directory is shown to callers: `.` for the repository root. */
export function displaySkillPath(dir: string): string {
  return dir === "" ? "." : dir;
}

/** Make an untrusted path printable for an error or rejection message. */
export function printablePath(path: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: replacing control characters for display.
  return path.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 300);
}
