/*
 * Path policy and the file routes. A path from the worker must be absolute, already normalized and under an
 * allowed root (/work, /skills in production). Symlinks are resolved inside the runner and the resolved path
 * must stay under a root too, so a link a session planted cannot point a read or write elsewhere.
 */
import { randomBytes } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { mkdir, open, realpath, rename, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HttpError, sendJson } from "./runner-http.ts";

export function isUnderRoot(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/** Lexical check of a worker-supplied path; the roots are already resolved (realpath) absolute paths. */
export function checkPath(path: string | null | undefined, roots: readonly string[]): string {
  if (!path || !isAbsolute(path) || path.includes("\0")) throw new HttpError(400, "path must be absolute");
  if (normalize(path) !== path || (path.length > 1 && path.endsWith("/"))) {
    throw new HttpError(400, "path must be normalized");
  }
  if (!isUnderRoot(path, roots)) throw new HttpError(403, "path is outside the allowed roots");
  return path;
}

async function resolveInside(path: string, roots: readonly string[]): Promise<string> {
  const resolved = await realpath(path);
  if (!isUnderRoot(resolved, roots)) throw new HttpError(403, "path resolves outside the allowed roots");
  return resolved;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** PUT: streams the body to a temp file beside the target, then renames it into place. */
export async function putFile(
  req: IncomingMessage,
  res: ServerResponse,
  rawPath: string | null,
  roots: readonly string[],
  maxBytes: number,
): Promise<void> {
  // An aborted upload (client gone, or the session closed under it) must fail the write, not leave it hanging.
  const aborted = new Promise<never>((_resolve, reject) => {
    req.once("close", () => {
      if (!req.complete) reject(new HttpError(499, "upload aborted"));
    });
  });
  aborted.catch(() => {});
  const path = checkPath(rawPath, roots);
  if (roots.includes(path)) throw new HttpError(400, "path is a root directory");
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, "file exceeds the size cap");
  await mkdir(dirname(path), { recursive: true });
  const parent = await resolveInside(dirname(path), roots);
  const target = join(parent, basename(path));
  const temp = join(parent, `.${basename(path)}.${randomBytes(6).toString("hex")}.part`);
  let received = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength;
      if (received > maxBytes) callback(new HttpError(413, "file exceeds the size cap"));
      else callback(null, chunk);
    },
  });
  // req is piped by hand, not handed to pipeline: a failed pipeline destroys its streams, and destroying the
  // request would cut the socket before the 413 reaches the worker.
  req.pipe(limiter);
  try {
    const writing = pipeline(limiter, createWriteStream(temp, { flags: "wx", mode: 0o644 }));
    writing.catch(() => {}); // when aborted wins the race, the destroyed pipeline's rejection is expected
    await Promise.race([writing, aborted]);
    await rename(temp, target);
  } catch (error) {
    req.unpipe(limiter);
    limiter.destroy();
    await rm(temp, { force: true });
    if (error instanceof HttpError) res.setHeader("connection", "close");
    throw error;
  }
  sendJson(res, 200, { ok: true, bytes: received });
}

/** GET: streams the file with its length; 404 when missing, 413 past the cap. */
export async function getFile(
  res: ServerResponse,
  rawPath: string | null,
  roots: readonly string[],
  maxBytes: number,
): Promise<void> {
  const path = checkPath(rawPath, roots);
  let resolved: string;
  try {
    resolved = await resolveInside(path, roots);
  } catch (error) {
    if (isMissing(error)) throw new HttpError(404, "file not found");
    throw error;
  }
  // Open before answering: an unreadable file (mode 000) must be an error status, never a 200 cut short.
  // O_NONBLOCK: a FIFO swapped in after the resolve would otherwise block a libuv thread forever; it opens at
  // once and is refused by the isFile check below. O_NOFOLLOW: a symlink swapped in after the resolve fails.
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(resolved, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (isMissing(error)) throw new HttpError(404, "file not found");
    if (code === "EACCES" || code === "EPERM") throw new HttpError(403, "file is not readable");
    if (code === "ELOOP") throw new HttpError(400, "path is not a regular file");
    throw error;
  }
  const info = await handle.stat().catch(async (error: unknown) => {
    await handle.close();
    throw error;
  });
  if (!info.isFile() || info.size > maxBytes) {
    await handle.close();
    if (!info.isFile()) throw new HttpError(400, "path is not a regular file");
    throw new HttpError(413, "file exceeds the size cap");
  }
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(info.size) });
  await pipeline(handle.createReadStream(), res).catch(() => {
    // The client went away mid-download; the response is already committed, nothing more to send.
    res.destroy();
  });
}
