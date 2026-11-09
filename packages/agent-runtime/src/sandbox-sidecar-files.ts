import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { StudixError } from "@studix/shared";
import { SANDBOX_SKILLS_DIR, SANDBOX_WORK_DIR, type SandboxSession } from "./sandbox-docker.ts";
import { RUNNER_ROUTES, RUNNER_SESSION_GONE_STATUS } from "./sandbox-runner-protocol.ts";
import {
  isSessionGone,
  type RunnerClient,
  runnerStatusError,
  SessionGoneError,
} from "./sandbox-sidecar-client.ts";
import { isSafeSkillPath } from "./skill-bundle-source.ts";

/*
 * File traffic with a sidecar runner. The runner shares no volume with the worker, so inputs, results and the
 * task's skills all travel through the file route: skills are copied to /skills when the session opens and
 * brought back (within caps) before the worker looks for skill edits.
 */

/** Touched after the skills are copied in; a skill file newer than it was written by the task. */
export const SKILLS_STAMP = `${SANDBOX_WORK_DIR}/.studix-skills-stamp`;
/** Caps on what a sync brings back; past them the edits are dropped (and logged), never half-stored. */
export const SKILL_SYNC_LIMITS = {
  maxFiles: 5_000,
  maxFileBytes: 10 * 1024 * 1024,
  maxBytes: 256 * 1024 * 1024,
};

const fileUrl = (sessionId: string, path: string) =>
  `${RUNNER_ROUTES.file(sessionId)}?path=${encodeURIComponent(path)}`;

export async function putRunnerFile(
  client: RunnerClient,
  sessionId: string,
  hostPath: string,
  path: string,
  signal: AbortSignal,
): Promise<void> {
  const body = Readable.toWeb(createReadStream(hostPath)) as unknown as ReadableStream<Uint8Array>;
  const res = await client.request(fileUrl(sessionId, path), {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body,
    // Required by fetch for a streamed request body.
    duplex: "half",
    signal,
  } as RequestInit);
  if (isSessionGone(res)) {
    await res.body?.cancel().catch(() => undefined);
    throw new SessionGoneError();
  }
  if (!res.ok) {
    const cause = await runnerStatusError(client.number, "store a file", res);
    throw new StudixError("UNAVAILABLE", `Could not copy an input file into the sandbox: ${cause.message}`, {
      retryable: true,
      cause,
    });
  }
  await res.body?.cancel().catch(() => undefined);
}

/** Streams a sandbox file to a host path through a temporary file, so a failed copy leaves nothing behind. */
export async function getRunnerFile(
  client: RunnerClient,
  sessionId: string,
  path: string,
  hostPath: string,
  signal: AbortSignal,
): Promise<void> {
  const res = await client.request(fileUrl(sessionId, path), { method: "GET", signal });
  // A 404 here is a missing file; only 410 says the session itself is gone.
  if (res.status === RUNNER_SESSION_GONE_STATUS) {
    await res.body?.cancel().catch(() => undefined);
    throw new SessionGoneError();
  }
  if (res.status === 404 || res.status === 413 || !res.ok || !res.body) {
    const reason =
      res.status === 404
        ? "No such file"
        : res.status === 413
          ? "larger than the runner's file limit"
          : (await runnerStatusError(client.number, "read a file", res)).message;
    await res.body?.cancel().catch(() => undefined);
    // Same error as the docker driver's failed `cat`.
    throw new StudixError("VALIDATION", `The sandbox has no readable ${path}: ${reason}`, {
      retryable: false,
    });
  }
  const temp = `${hostPath}.part-${process.pid}-${Date.now()}`;
  try {
    await pipeline(
      Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>),
      createWriteStream(temp),
    );
    await rename(temp, hostPath);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Regular files under `root`, as POSIX relative paths with their mode; symlinks and specials are skipped. */
async function hostFiles(
  root: string,
  dir = root,
  out = new Map<string, number>(),
): Promise<Map<string, number>> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) await hostFiles(root, full, out);
    else if (info.isFile()) out.set(relative(root, full).split(sep).join("/"), info.mode);
  }
  return out;
}

/** Copies a host skills directory to /skills (regular files, safe names) and keeps the executable bit. */
export async function uploadSkills(
  session: Pick<SandboxSession, "copyIn" | "run">,
  hostDir: string,
): Promise<void> {
  const files = await hostFiles(hostDir);
  const executable: string[] = [];
  for (const [rel, mode] of files) {
    if (!isSafeSkillPath(rel) || /[\n\r]/.test(rel)) continue;
    const target = `${SANDBOX_SKILLS_DIR}/${rel}`;
    await session.copyIn(join(hostDir, ...rel.split("/")), target);
    if (mode & 0o111) executable.push(target);
  }
  // Paths go through stdin, so no list is ever too long for the exec header.
  if (executable.length > 0) {
    await session.run(["sh", "-c", 'while IFS= read -r f; do chmod 755 "$f"; done'], {
      stdin: `${executable.join("\n")}\n`,
    });
  }
  await session.run(["touch", SKILLS_STAMP]);
}

interface RemoteFile {
  path: string;
  size: number;
  mode: number;
}

/** Records end with NUL, not newline: a file name may contain a newline. */
function parseListing(text: string): RemoteFile[] {
  const files: RemoteFile[] = [];
  for (const line of text.split("\0")) {
    const match = /^(\d+) ([0-7]+) (.+)$/s.exec(line);
    if (match)
      files.push({
        size: Number(match[1]),
        mode: Number.parseInt(match[2] as string, 8),
        path: match[3] as string,
      });
  }
  return files;
}

/**
 * Makes `hostDir` match the sandbox's /skills: deletes what the task removed, downloads what it added or
 * changed. Returns a reason instead when the tree is past SKILL_SYNC_LIMITS; the host directory is then left
 * as it was opened, so no edit is stored.
 */
export async function syncSkillsFromRunner(
  session: Pick<SandboxSession, "copyOut" | "run">,
  hostDir: string,
): Promise<{ synced: true } | { synced: false; reason: string }> {
  const remote = parseListing(
    (await session.run(["find", SANDBOX_SKILLS_DIR, "-type", "f", "-printf", "%s %m %P\\0"])).toString(
      "utf8",
    ),
  ).filter((f) => isSafeSkillPath(f.path));
  const newer = new Set(
    (
      await session
        .run(["find", SANDBOX_SKILLS_DIR, "-type", "f", "-newer", SKILLS_STAMP, "-printf", "%P\\0"])
        .catch(() => Buffer.from(remote.map((f) => f.path).join("\0")))
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean),
  );
  const total = remote.reduce((sum, f) => sum + f.size, 0);
  const tooBig = remote.find((f) => f.size > SKILL_SYNC_LIMITS.maxFileBytes);
  if (remote.length > SKILL_SYNC_LIMITS.maxFiles)
    return { synced: false, reason: `more than ${SKILL_SYNC_LIMITS.maxFiles} files` };
  if (total > SKILL_SYNC_LIMITS.maxBytes)
    return { synced: false, reason: "larger than the skill sync limit" };
  if (tooBig)
    return { synced: false, reason: `a file is larger than ${SKILL_SYNC_LIMITS.maxFileBytes} bytes` };

  // Download into a staging dir first: one unreadable file must leave hostDir exactly as it was opened, never
  // half synced (the caller stores whatever differs from the opened skills).
  const local = await hostFiles(hostDir);
  const staging = `${hostDir}.sync-${process.pid}-${Date.now()}`;
  const fetched: RemoteFile[] = [];
  try {
    for (const file of remote) {
      if (local.has(file.path) && !newer.has(file.path)) continue;
      const staged = join(staging, ...file.path.split("/"));
      await mkdir(dirname(staged), { recursive: true });
      await session.copyOut(`${SANDBOX_SKILLS_DIR}/${file.path}`, staged);
      fetched.push(file);
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    // A stopped or cancelled session is the task's failure, not one bad file.
    if (
      error instanceof SessionGoneError ||
      (error instanceof StudixError && (error.code === "TIMEOUT" || error.code === "CANCELLED"))
    )
      throw error;
    return { synced: false, reason: `a file could not be read: ${String(error).slice(0, 200)}` };
  }
  const wanted = new Set(remote.map((f) => f.path));
  for (const rel of local.keys()) {
    if (!wanted.has(rel)) await rm(join(hostDir, ...rel.split("/")), { force: true });
  }
  for (const file of fetched) {
    const target = join(hostDir, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await rename(join(staging, ...file.path.split("/")), target);
  }
  await rm(staging, { recursive: true, force: true });
  for (const file of remote) {
    await chmod(join(hostDir, ...file.path.split("/")), file.mode & 0o111 ? 0o755 : 0o644);
  }
  return { synced: true };
}
