import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";
import {
  createDockerSandboxDriver,
  type SandboxDriver,
  type SandboxLimits,
  type SandboxSession,
} from "@studix/agent-runtime";
import {
  type AssetKind,
  type AssetRepository,
  buildMediaExecArgv,
  MEDIA_EXEC_INPUT_DIR,
  MEDIA_EXEC_OUTPUT_DIR,
  type MediaExecRequest,
  type MediaExecResult,
  mediaExecContentType,
  type StorageAdapter,
  type TenantContext,
} from "@studix/core";
import { type Logger, StudixError } from "@studix/shared";
import { blockedAddressReason, guardedLookup, sha256File } from "@studix/storage";
import { type MediaExecRunner, reachedTimeout } from "@studix/workflow";
import { z } from "zod";
import type { SandboxSettings } from "./skill-sandbox.ts";

/*
 * The worker side of `media.exec` (docs/SECURITY.md#media-exec): one sandbox container per job from the skill
 * sandbox image, always with `--network none`, no environment variables and only the declared inputs in its
 * scratch directory. Studix fetches URL inputs itself (HTTPS, public addresses only) before the run.
 */

const Env = z.object({
  STUDIX_MEDIA_EXEC_MAX_INPUT_MB: z.coerce.number().int().min(1).max(16_384).default(512),
  STUDIX_MEDIA_EXEC_MAX_OUTPUT_MB: z.coerce.number().int().min(1).max(65_536).default(2048),
  STUDIX_MEDIA_EXEC_CENTS_PER_MINUTE: z.coerce.number().min(0).max(10_000).default(1),
});

export interface MediaExecSettings {
  maxInputBytes: number;
  maxOutputBytes: number;
  centsPerMinute: number;
  /** stdout/stderr returned with the result; ffprobe JSON is parsed from up to `jsonBytes` of stdout. */
  logBytes: number;
  jsonBytes: number;
}

export function loadMediaExecSettings(env: NodeJS.ProcessEnv): MediaExecSettings {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""),
  );
  const parsed = Env.safeParse(cleaned);
  if (!parsed.success) {
    throw new StudixError(
      "VALIDATION",
      `Invalid media exec configuration: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  }
  const s = parsed.data;
  return {
    maxInputBytes: s.STUDIX_MEDIA_EXEC_MAX_INPUT_MB * 1024 * 1024,
    maxOutputBytes: s.STUDIX_MEDIA_EXEC_MAX_OUTPUT_MB * 1024 * 1024,
    centsPerMinute: s.STUDIX_MEDIA_EXEC_CENTS_PER_MINUTE,
    logBytes: 16 * 1024,
    jsonBytes: 4 * 1024 * 1024,
  };
}

/** POSIX single-quote quoting: the argument reaches the tool as one argv entry, never shell syntax. */
export function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** The exit code reported for a tool the sandbox killed (the `timeout(1)` convention). */
const KILLED_EXIT_CODE = 124;

/** The stderr line for a killed tool: a timeout only when it ran for its whole `timeoutSeconds`. */
export function killedNote(durationMs: number, timeoutSeconds: number): string {
  return reachedTimeout(durationMs, timeoutSeconds)
    ? `[studix] killed after ${timeoutSeconds}s timeout`
    : "[studix] the command was killed";
}

function assetKind(contentType: string): AssetKind {
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("image/")) return "image";
  return "document";
}

const URL_POLICY = { allowLocal: false } as const;
const MAX_REDIRECTS = 3;

function refusedUrl(reason: string): StudixError {
  return new StudixError("VALIDATION", `The input URL was refused: ${reason}`, {
    retryable: false,
    details: { reason },
    suggestedAction: "Use a public https URL, or upload the file as an asset.",
  });
}

/** Static URL checks before any connection: https, no credentials, no internal names or blocked IP literals. */
export function assertPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw refusedUrl("not a URL");
  }
  if (url.protocol !== "https:") throw refusedUrl("only https is allowed");
  if (url.username || url.password) throw refusedUrl("credentials in the URL");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || /\.(internal|local|localdomain|localhost)$/u.test(host)) {
    throw refusedUrl("internal host name");
  }
  if (isIP(host) && blockedAddressReason(host, URL_POLICY)) throw refusedUrl("private or reserved address");
  return url;
}

/** A body fetched through the SSRF guard, with its content type and the URL it was finally served from. */
export interface PublicFetch {
  body: Buffer;
  /** The media type of the response, lowercased, without parameters; empty when the server sent none. */
  contentType: string;
  /** Final URL after redirects. */
  url: string;
}

/**
 * Download a public https URL through the SSRF guard: every hop is re-checked, the socket refuses private and
 * metadata addresses at connect time (DNS rebinding), and the body is capped.
 */
export async function fetchPublic(
  raw: string,
  options: { maxBytes: number; truncate?: boolean },
  signal: AbortSignal,
): Promise<PublicFetch> {
  const { maxBytes, truncate = false } = options;
  let url = assertPublicHttpsUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await new Promise<{ location?: string; body?: Buffer; contentType?: string }>(
      (resolve, reject) => {
        const req = httpsRequest(
          url,
          {
            method: "GET",
            lookup: guardedLookup(URL_POLICY),
            signal,
            timeout: 60_000,
            headers: { "user-agent": "Mozilla/5.0 (compatible; Studix)", accept: "*/*" },
          },
          (res) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400 && res.headers.location) {
              res.resume();
              resolve({ location: res.headers.location });
              return;
            }
            if (status !== 200) {
              res.resume();
              reject(refusedUrl(`HTTP ${status}`));
              return;
            }
            const declared = Number(res.headers["content-length"] ?? 0);
            if (declared > maxBytes && !truncate) {
              res.destroy();
              reject(refusedUrl("larger than the input limit"));
              return;
            }
            const contentType = (res.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
            const chunks: Buffer[] = [];
            let bytes = 0;
            res.on("data", (c: Buffer) => {
              bytes += c.length;
              if (bytes > maxBytes) {
                res.destroy();
                // A truncating read keeps the first `maxBytes` (a page's <head> comes first).
                if (truncate) {
                  chunks.push(c.subarray(0, c.length - (bytes - maxBytes)));
                  resolve({ body: Buffer.concat(chunks), contentType });
                } else reject(refusedUrl("larger than the input limit"));
                return;
              }
              chunks.push(c);
            });
            res.once("end", () => resolve({ body: Buffer.concat(chunks), contentType }));
            res.once("error", reject);
          },
        );
        req.once("timeout", () => req.destroy(new Error("timeout")));
        req.once("error", (err: NodeJS.ErrnoException) =>
          reject(
            err instanceof StudixError
              ? err
              : refusedUrl(
                  err.code === "ESTORAGEBLOCKED" ? "private or reserved address" : "could not be fetched",
                ),
          ),
        );
        req.end();
      },
    );
    if (response.body)
      return { body: response.body, contentType: response.contentType ?? "", url: url.toString() };
    url = assertPublicHttpsUrl(new URL(response.location as string, url).toString());
  }
  throw refusedUrl("too many redirects");
}

/** Download a media-exec URL input through the SSRF guard ({@link fetchPublic}); the body only. */
export async function fetchPublicUrl(raw: string, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  return (await fetchPublic(raw, { maxBytes }, signal)).body;
}

export interface MediaExecRunnerDeps {
  sandbox: SandboxSettings;
  settings: MediaExecSettings;
  /** Host directory for per-job scratch and downloaded outputs. */
  workDir: string;
  storage: StorageAdapter;
  assets: AssetRepository;
  logger: Logger;
  /** Test seam; default a docker driver on the sandbox image with no network. */
  driver?: SandboxDriver;
}

/** media.exec relies on `--network none`; a sidecar runner keeps the Pod's network, so it never runs there. */
export function mediaExecNeedsDocker(): StudixError {
  return new StudixError(
    "UNAVAILABLE",
    "media.exec needs a network-isolated sandbox, and the sidecar skill runner (STUDIX_SANDBOX=sidecar) cannot cut egress",
    {
      retryable: false,
      details: { backend: "sidecar" },
      suggestedAction:
        "Run media.exec on a worker with STUDIX_SANDBOX=docker on a host with Docker, or use composition.run for ffmpeg work in the skill sandbox.",
    },
  );
}

export function createMediaExecRunner(deps: MediaExecRunnerDeps): MediaExecRunner {
  const { settings } = deps;
  if (deps.sandbox.sidecar && !deps.driver) {
    return {
      async run() {
        throw mediaExecNeedsDocker();
      },
    };
  }
  const driver =
    deps.driver ??
    createDockerSandboxDriver({
      image: deps.sandbox.image,
      workRoot: join(deps.workDir, "media-exec"),
      // Never the skill sandbox network: a media run has no egress at all.
      network: "none",
      ...(deps.sandbox.docker ? { docker: deps.sandbox.docker } : {}),
    });

  async function loadInput(
    ctx: TenantContext,
    source: MediaExecRequest["inputs"][string],
    signal: AbortSignal,
  ): Promise<{ body: Buffer; derivedFrom?: string }> {
    if ("base64" in source) return { body: Buffer.from(source.base64, "base64") };
    if ("url" in source) return { body: await fetchPublicUrl(source.url, settings.maxInputBytes, signal) };
    const asset = await deps.assets.get(ctx, source.assetId);
    const version = asset?.currentVersionId
      ? await deps.assets.getVersion(ctx, asset.currentVersionId)
      : undefined;
    if (!version) {
      throw new StudixError("NOT_FOUND", `asset ${source.assetId} has no stored version`, {
        retryable: false,
      });
    }
    if (version.bytes > settings.maxInputBytes) {
      throw new StudixError("VALIDATION", `asset ${source.assetId} is larger than the input limit`, {
        retryable: false,
        details: { maxBytes: settings.maxInputBytes },
      });
    }
    const object = await deps.storage.get(ctx, version.storageKey);
    const chunks: Uint8Array[] = [];
    for await (const chunk of object.body as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
    return { body: Buffer.concat(chunks), derivedFrom: version.id };
  }

  async function readLog(session: SandboxSession, file: string, fromEnd: boolean) {
    const size = Number((await session.run(["stat", "-c", "%s", file])).toString("utf8").trim()) || 0;
    const limit = settings.logBytes;
    const text = (
      await session.run(fromEnd ? ["tail", "-c", String(limit), file] : ["head", "-c", String(limit), file])
    ).toString("utf8");
    return { text, truncated: size > limit, size };
  }

  return {
    async run(s, request) {
      const { ctx, signal } = s;
      const limits: SandboxLimits = {
        ...deps.sandbox.limits,
        // The container outlives the command by a margin for staging files in and out.
        wallTimeMs: (request.timeoutSeconds + 120) * 1000,
      };
      const session = await driver.open({ taskId: `mx-${s.job.id}-${s.attempt}`, env: {}, limits, signal });
      const hostOut = join(deps.workDir, s.job.id, `attempt-${s.attempt}`, "media-exec-out");
      try {
        await session.run(["mkdir", "-p", MEDIA_EXEC_INPUT_DIR, MEDIA_EXEC_OUTPUT_DIR]);
        let inputBytes = 0;
        const derivedFrom: string[] = [];
        for (const [name, source] of Object.entries(request.inputs)) {
          const { body, derivedFrom: from } = await loadInput(ctx, source, signal);
          inputBytes += body.length;
          if (inputBytes > settings.maxInputBytes) {
            throw new StudixError("VALIDATION", "The inputs are larger than the input limit", {
              retryable: false,
              details: { maxBytes: settings.maxInputBytes },
            });
          }
          if (from) derivedFrom.push(from);
          await session.run(["sh", "-c", 'cat > "$1"', "sh", `${MEDIA_EXEC_INPUT_DIR}/${name}`], {
            stdin: body,
            signal,
          });
        }

        const argv = buildMediaExecArgv(request);
        // ulimit -f counts 512-byte blocks in dash; the exact cap is checked on the outputs afterwards.
        const blocks = Math.ceil(settings.maxOutputBytes / 512);
        const command = `ulimit -f ${blocks}; exec ${argv.map(shellQuote).join(" ")} >/work/.stdout 2>/work/.stderr`;
        const started = Date.now();
        const { exitCode } = await session.exec(command, {
          cwd: "/work",
          timeoutSeconds: request.timeoutSeconds,
          signal,
        });
        const durationMs = Date.now() - started;
        if (signal.aborted)
          throw new StudixError("CANCELLED", "The media exec job was cancelled", { retryable: false });

        const stdout = await readLog(session, "/work/.stdout", false);
        const stderr = await readLog(session, "/work/.stderr", true);
        const killed = exitCode === null;
        const result: MediaExecResult = {
          tool: request.tool,
          exitCode: killed ? KILLED_EXIT_CODE : exitCode,
          killed,
          durationMs,
          stdout: stdout.text,
          stderr: killed ? `${stderr.text}\n${killedNote(durationMs, request.timeoutSeconds)}` : stderr.text,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          outputs: [],
        };
        if (request.tool === "ffprobe" && result.exitCode === 0 && stdout.size <= settings.jsonBytes) {
          const full = stdout.truncated
            ? (await session.run(["cat", "/work/.stdout"])).toString("utf8")
            : stdout.text;
          try {
            result.json = JSON.parse(full);
          } catch {
            // Not JSON output (-of default/csv); stdout carries it.
          }
        }
        if (result.exitCode !== 0) return result;

        await mkdir(hostOut, { recursive: true });
        let outputBytes = 0;
        for (const output of request.outputs) {
          const path = `${MEDIA_EXEC_OUTPUT_DIR}/${output.name}`;
          const size = Number(
            (await session.run(["sh", "-c", 'test -f "$1" && stat -c %s "$1" || echo -1', "sh", path]))
              .toString("utf8")
              .trim(),
          );
          if (size < 0) {
            throw new StudixError(
              "VALIDATION",
              `${request.tool} did not write the declared output ${output.name}`,
              {
                retryable: false,
                details: { output: output.name, stderrTail: result.stderr.slice(-2000) },
              },
            );
          }
          outputBytes += size;
          if (outputBytes > settings.maxOutputBytes) {
            throw new StudixError("VALIDATION", "The outputs are larger than the output limit", {
              retryable: false,
              details: { maxBytes: settings.maxOutputBytes },
            });
          }
          const hostPath = join(hostOut, `${randomUUID()}-${output.name}`);
          await session.copyOut(path, hostPath);
          const { sha256, bytes } = await sha256File(hostPath);
          const contentType = mediaExecContentType(output.name, output.contentType);
          const asset = await deps.assets.create(ctx, {
            ...(s.job.projectId ? { projectId: s.job.projectId } : {}),
            kind: assetKind(contentType),
            name: output.name,
            createdBy: { type: "system", id: "media-exec" },
          });
          const storageKey = `assets/${asset.id}/v1/${output.name}`;
          await deps.storage.put(ctx, storageKey, { filePath: hostPath }, { contentType, sha256 });
          const version = await deps.assets.addVersion(ctx, {
            assetId: asset.id,
            storageKey,
            sha256,
            mime: contentType,
            bytes,
            provenance: {
              source: "generated",
              provider: request.tool,
              ...(derivedFrom.length > 0 ? { derivedFrom: derivedFrom.slice(0, 32) } : {}),
            },
            createdBy: { type: "system", id: "media-exec" },
          });
          result.outputs.push({
            name: output.name,
            assetId: asset.id,
            assetVersionId: version.id,
            storageKey,
            contentType,
            bytes,
            sha256,
          });
          await rm(hostPath, { force: true });
        }
        return result;
      } finally {
        await session.close();
        await rm(hostOut, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
