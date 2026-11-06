import type { FetchedSkillFile, SkillLicense } from "@studix/core";
import { decodeBase64, decodeUtf8, sha256Hex } from "./github-blob.ts";
import type { GitHubSession } from "./github-client.ts";
import { LicenseResponse } from "./github-schemas.ts";
import type { RepoRef } from "./github-tree.ts";
import { metadataSha } from "./skill-files.ts";

export interface RepoLicense {
  spdxId?: string;
  name?: string;
  text?: string;
  /** The license file as a skill file entry, stored when it is small enough to keep with each skill. */
  file?: FetchedSkillFile;
}

const MAX_LICENSE_BYTES = 64 * 1024;
const MAX_NOTICES = 5;
const MAX_NOTICE_LENGTH = 200;
const LICENSE_TYPE = "text/plain; charset=utf-8";
/** Common SPDX identifiers recognised when a skill declares its license only in the frontmatter. */
const KNOWN_SPDX = new Set(
  [
    "MIT",
    "MIT-0",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "MPL-2.0",
    "GPL-2.0-only",
    "GPL-2.0-or-later",
    "GPL-3.0-only",
    "GPL-3.0-or-later",
    "LGPL-2.1-only",
    "LGPL-2.1-or-later",
    "LGPL-3.0-only",
    "LGPL-3.0-or-later",
    "AGPL-3.0-only",
    "AGPL-3.0-or-later",
    "Unlicense",
    "CC0-1.0",
    "CC-BY-4.0",
    "CC-BY-SA-4.0",
  ].map((id) => id.toLowerCase()),
);

function isRealSpdx(id: string | null | undefined): id is string {
  return typeof id === "string" && id !== "" && !["noassertion", "other"].includes(id.toLowerCase());
}

/** Fetch the repository license once; `undefined` when the repository declares none. */
export async function fetchRepoLicense(
  session: GitHubSession,
  ref: RepoRef,
): Promise<RepoLicense | undefined> {
  const response = await session.getOptionalJson(LicenseResponse, ["repos", ref.owner, ref.repo, "license"]);
  if (!response) return undefined;
  const license: RepoLicense = {
    spdxId: response.license?.spdx_id ?? undefined,
    name: response.license?.name ?? undefined,
  };
  const size = response.size ?? 0;
  const entry = { path: "LICENSE", kind: "license" as const, bytes: size, contentType: LICENSE_TYPE };
  const sha = response.sha === undefined ? "" : metadataSha(response.sha);
  if (size > MAX_LICENSE_BYTES) {
    license.file = {
      ...entry,
      sha256: sha,
      skipped: `too large (${size} bytes, limit ${MAX_LICENSE_BYTES})`,
    };
    return license;
  }
  if (response.content === undefined || response.encoding !== "base64") return license;
  const bytes = decodeBase64(response.content, size);
  const text = bytes === undefined ? undefined : decodeUtf8(bytes);
  if (bytes === undefined || text === undefined) return license;
  license.text = text;
  license.file = { ...entry, sha256: sha256Hex(bytes), content: bytes };
  return license;
}

/** Combine the repository license with a frontmatter `license` field. Uncertain unless a real SPDX id. */
export function resolveLicense(
  repo: RepoLicense | undefined,
  frontmatter: Record<string, unknown>,
): SkillLicense {
  const raw =
    typeof frontmatter.license === "string" ? frontmatter.license.trim().slice(0, MAX_NOTICE_LENGTH) : "";
  const declaredSpdx = raw !== "" && KNOWN_SPDX.has(raw.toLowerCase()) ? raw : undefined;
  if (repo) {
    const real = isRealSpdx(repo.spdxId);
    const license: SkillLicense = { source: "repository", uncertain: !real };
    if (real) license.spdxId = repo.spdxId;
    if (repo.name) license.name = repo.name;
    if (raw !== "" && raw.toLowerCase() !== repo.spdxId?.toLowerCase()) license.declared = raw;
    return license;
  }
  if (declaredSpdx) return { source: "frontmatter", spdxId: declaredSpdx, uncertain: false };
  if (raw !== "") return { source: "frontmatter", declared: raw, uncertain: true };
  return { source: "none", uncertain: true };
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

/** Author and copyright lines from the frontmatter and the license text, bounded and de-duplicated. */
export function collectNotices(
  frontmatter: Record<string, unknown>,
  licenseText: string | undefined,
): string[] {
  const fromFrontmatter = ["author", "authors", "copyright"].flatMap((key) => stringValues(frontmatter[key]));
  const fromLicense = (licenseText ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("Copyright"));
  const notices = [...fromFrontmatter, ...fromLicense]
    .map((line) => line.trim().slice(0, MAX_NOTICE_LENGTH))
    .filter((line) => line !== "");
  return [...new Set(notices)].slice(0, MAX_NOTICES);
}
