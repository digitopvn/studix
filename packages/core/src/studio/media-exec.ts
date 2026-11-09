import { StudixError } from "@studix/shared";
import { z } from "zod";

/*
 * `media.exec`: ffmpeg or ffprobe with caller-supplied arguments, run in the worker's sandbox container
 * (docs/SECURITY.md#media-exec). Any filter, codec or option is allowed. Safety comes from isolation: the
 * container has no network, no server environment and only the declared input files, and the checks here
 * keep arguments from naming anything outside the job's scratch directory.
 */

export const MEDIA_EXEC_TOOLS = ["ffmpeg", "ffprobe"] as const;
export type MediaExecTool = (typeof MEDIA_EXEC_TOOLS)[number];

/** Where a job's files live inside the sandbox container. */
export const MEDIA_EXEC_DIR = "/work";
export const MEDIA_EXEC_INPUT_DIR = `${MEDIA_EXEC_DIR}/in`;
export const MEDIA_EXEC_OUTPUT_DIR = `${MEDIA_EXEC_DIR}/out`;

export const MEDIA_EXEC_LIMITS = {
  args: 500,
  argChars: 8000,
  inputs: 16,
  outputs: 16,
  /** Decoded size of one inline base64 input; larger files go through an asset or a URL. */
  base64Bytes: 2 * 1024 * 1024,
  /** Decoded size of all inline inputs of one call (they are stored in the job payload). */
  base64TotalBytes: 4 * 1024 * 1024,
  defaultTimeoutSeconds: 300,
  maxTimeoutSeconds: 1800,
} as const;

/** A file name inside the scratch directory: no separators, no leading dot, an optional extension. */
const FileName = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/,
    "letters, digits, '_', '.' and '-', starting with a letter or digit",
  )
  .refine((v) => !v.includes(".."), "must not contain '..'");

const ContentType = z
  .string()
  .regex(/^[a-z]+\/[A-Za-z0-9.+-]{1,100}$/, "a media type like video/mp4")
  .max(120);

export const MediaExecInputSource = z.union([
  z.object({ assetId: z.string().trim().min(1).max(100) }).strict(),
  z.object({ url: z.url().max(4000) }).strict(),
  z
    .object({
      base64: z
        .string()
        .min(1)
        .max(Math.ceil((MEDIA_EXEC_LIMITS.base64Bytes * 4) / 3) + 4),
    })
    .strict(),
]);
export type MediaExecInputSource = z.infer<typeof MediaExecInputSource>;

export const MediaExecOutput = z.object({ name: FileName, contentType: ContentType.optional() }).strict();
export type MediaExecOutput = z.infer<typeof MediaExecOutput>;

export const MediaExecRequest = z
  .object({
    tool: z.enum(MEDIA_EXEC_TOOLS),
    args: z.array(z.string().max(MEDIA_EXEC_LIMITS.argChars)).max(MEDIA_EXEC_LIMITS.args),
    inputs: z
      .record(FileName, MediaExecInputSource)
      .default({})
      .refine((v) => Object.keys(v).length <= MEDIA_EXEC_LIMITS.inputs, {
        message: `at most ${MEDIA_EXEC_LIMITS.inputs} inputs`,
      }),
    outputs: z.array(MediaExecOutput).max(MEDIA_EXEC_LIMITS.outputs).default([]),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(MEDIA_EXEC_LIMITS.maxTimeoutSeconds)
      .default(MEDIA_EXEC_LIMITS.defaultTimeoutSeconds),
  })
  .strict();
export type MediaExecRequest = z.output<typeof MediaExecRequest>;

function invalid(message: string, details: Record<string, unknown>): StudixError {
  return new StudixError("VALIDATION", message, {
    retryable: false,
    details,
    suggestedAction:
      "Reference files only through {in:<name>} and {out:<name>} placeholders and keep paths relative.",
  });
}

const PLACEHOLDER = /\{(in|out):([^{}]*)\}/g;

/** Options that would re-open protocols or read files the placeholders do not name. */
const REFUSED_OPTIONS = new Set(["-protocol_whitelist", "-protocol_blacklist", "-safe"]);

/**
 * A path or URL outside the scratch directory: an absolute POSIX or Windows path, a home path, a parent
 * segment, or a `scheme://` URL. Checked on the argument text with the placeholders removed, at the start
 * of the argument or after a delimiter of ffmpeg's option and filtergraph syntax (so `scale=iw/2` passes).
 */
const OUTSIDE_PATH = [
  { reason: "url", pattern: /[A-Za-z][A-Za-z0-9+.-]*:\/\//u },
  { reason: "absolute_path", pattern: /(^|[\s=:,;'"|[(<>])\//u },
  { reason: "windows_path", pattern: /(^|[\s=:,;'"|[(<>])([A-Za-z]:)?\\/u },
  { reason: "windows_path", pattern: /(^|[\s=,;'"|[(<>])[A-Za-z]:[\\/]/u },
  { reason: "home_path", pattern: /(^|[\s=:,;'"|[(<>])~[/\\]?/u },
  { reason: "parent_path", pattern: /(^|[\s=:,;'"|[(<>/\\])\.\.([/\\]|$|[\s:,;'"|\])])/u },
] as const;

/** ffmpeg protocol prefixes (`concat:`, `subfile,`, `file:`) that could reach past a placeholder. */
const PROTOCOL_PREFIX =
  /^(?:async|cache|concat|concatf|crypto|data|fd|file|ftp|gopher|gophers|hls|http|https|httpproxy|icecast|ipfs|ipns|md5|mmsh|mmst|pipe|prompeg|rtmp\w*|rtp|sctp|srt|srtp|subfile|tcp|tee|tls|udp|udplite|unix|zmq)[:,]/iu;

export interface PlaceholderRefs {
  inputs: Set<string>;
  outputs: Set<string>;
}

/**
 * Check every argument and collect the placeholders it uses. Throws VALIDATION for an undeclared
 * placeholder, a path or URL outside the scratch directory, or an option that reopens protocols.
 */
export function validateMediaExecArgs(request: MediaExecRequest): PlaceholderRefs {
  const declaredIn = new Set(Object.keys(request.inputs));
  const declaredOut = new Set(request.outputs.map((o) => o.name));
  if (declaredOut.size !== request.outputs.length) {
    throw invalid("Output names must be unique", { field: "outputs" });
  }
  const refs: PlaceholderRefs = { inputs: new Set(), outputs: new Set() };
  request.args.forEach((arg, index) => {
    if (/[\0\r\n]/u.test(arg)) throw invalid("Arguments must not contain NUL or line breaks", { index });
    if (REFUSED_OPTIONS.has(arg)) {
      throw invalid(`${arg} is set by Studix and cannot be passed`, { index, reason: "refused_option" });
    }
    for (const match of arg.matchAll(PLACEHOLDER)) {
      const [, kind, name] = match as unknown as [string, "in" | "out", string];
      const declared = kind === "in" ? declaredIn : declaredOut;
      if (!declared.has(name)) {
        throw invalid(`{${kind}:${name}} is not a declared ${kind === "in" ? "input" : "output"}`, {
          index,
          reason: "undeclared_placeholder",
        });
      }
      (kind === "in" ? refs.inputs : refs.outputs).add(name);
    }
    const bare = arg.replace(PLACEHOLDER, "x");
    for (const check of OUTSIDE_PATH) {
      if (check.pattern.test(bare)) {
        throw invalid("Arguments must not reference paths or URLs outside the job directory", {
          index,
          reason: check.reason,
        });
      }
    }
    if (PROTOCOL_PREFIX.test(bare) && !arg.startsWith("{")) {
      throw invalid("Protocol prefixes are not allowed; reference files with placeholders", {
        index,
        reason: "protocol",
      });
    }
  });
  return refs;
}

/**
 * The argv run in the sandbox: placeholders become scratch paths, `-hide_banner` and (for ffmpeg) `-nostdin`
 * lead, and every `-i` is preceded by `-protocol_whitelist file,pipe` so a demuxer cannot open other
 * protocols (playlists, concat lists, `movie=` sources). ffprobe gets the whitelist once, before its input.
 */
export function buildMediaExecArgv(request: MediaExecRequest): string[] {
  validateMediaExecArgs(request);
  const substitute = (arg: string) =>
    arg.replace(PLACEHOLDER, (_m, kind: string, name: string) =>
      kind === "in" ? `${MEDIA_EXEC_INPUT_DIR}/${name}` : `${MEDIA_EXEC_OUTPUT_DIR}/${name}`,
    );
  const whitelist = ["-protocol_whitelist", "file,pipe"];
  const argv: string[] = [request.tool, "-hide_banner"];
  if (request.tool === "ffmpeg") {
    argv.push("-nostdin");
    for (const arg of request.args) {
      if (arg === "-i") argv.push(...whitelist);
      argv.push(substitute(arg));
    }
  } else {
    argv.push(...whitelist, ...request.args.map(substitute));
  }
  return argv;
}

/** Decoded size of a base64 string without decoding it. */
export function base64DecodedBytes(value: string): number {
  const clean = value.replace(/\s/gu, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

/** Parse and fully check a request (schema, placeholders, paths, inline input sizes). */
export function parseMediaExecRequest(raw: unknown): MediaExecRequest {
  const parsed = MediaExecRequest.safeParse(raw);
  if (!parsed.success) {
    throw new StudixError("VALIDATION", "Invalid media exec request", {
      retryable: false,
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    });
  }
  const request = parsed.data;
  if (request.tool === "ffmpeg" && request.outputs.length === 0) {
    throw invalid("ffmpeg needs at least one declared output", { field: "outputs" });
  }
  let inline = 0;
  for (const [name, source] of Object.entries(request.inputs)) {
    if (!("base64" in source)) continue;
    if (!/^[A-Za-z0-9+/\s]*={0,2}$/u.test(source.base64)) {
      throw invalid(`Input ${name} is not valid base64`, { field: `inputs.${name}` });
    }
    const bytes = base64DecodedBytes(source.base64);
    if (bytes > MEDIA_EXEC_LIMITS.base64Bytes) {
      throw invalid(`Input ${name} is too large for base64; upload it as an asset or pass a URL`, {
        field: `inputs.${name}`,
        maxBytes: MEDIA_EXEC_LIMITS.base64Bytes,
      });
    }
    inline += bytes;
  }
  if (inline > MEDIA_EXEC_LIMITS.base64TotalBytes) {
    throw invalid("Inline base64 inputs are too large in total", {
      field: "inputs",
      maxBytes: MEDIA_EXEC_LIMITS.base64TotalBytes,
    });
  }
  const refs = validateMediaExecArgs(request);
  for (const output of request.outputs) {
    if (!refs.outputs.has(output.name)) {
      throw invalid(`Output ${output.name} is declared but no argument writes {out:${output.name}}`, {
        field: "outputs",
      });
    }
  }
  return request;
}

/** Content type of an output when the caller gave none, from its extension. */
export function mediaExecContentType(name: string, given?: string): string {
  if (given) return given;
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const types: Record<string, string> = {
    mp4: "video/mp4",
    m4v: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    mkv: "video/x-matroska",
    gif: "image/gif",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    wav: "audio/wav",
    ogg: "audio/ogg",
    opus: "audio/opus",
    flac: "audio/flac",
    srt: "application/x-subrip",
    vtt: "text/vtt",
    json: "application/json",
    txt: "text/plain",
  };
  return types[ext] ?? "application/octet-stream";
}

/** What `studix_get_job` shows for a finished `media.exec` job (stored as the job result). */
export interface MediaExecResult {
  tool: MediaExecTool;
  /** The tool's exit code; 124 (the `timeout(1)` convention) when it was killed and never exited. */
  exitCode: number;
  /** True when the sandbox killed the tool (its timeout, or the sandbox stopping); false when it exited. */
  killed: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** ffprobe output parsed when it printed JSON. */
  json?: unknown;
  outputs: Array<{
    name: string;
    assetId: string;
    assetVersionId: string;
    storageKey: string;
    contentType: string;
    bytes: number;
    sha256: string;
  }>;
}
