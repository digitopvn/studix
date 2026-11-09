import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  assertCompositionFits,
  COMPOSITION_LIMITS,
  type CompositionCheck,
  type CompositionFile,
  CompositionPath,
  type CompositionRunResult,
  compositionContentType,
  compositionCountAfter,
  compositionFileKey,
  loadCompositionManifest,
  mergeManifest,
  type StorageAdapter,
  saveCompositionManifest,
} from "@studix/core";
import {
  checkFrames,
  FfmpegProbe,
  type LoudnessMeasurement,
  measureLoudness,
  writeContactSheet,
} from "@studix/renderers";
import { type Logger, StudixError } from "@studix/shared";
import { sha256File } from "@studix/storage";
import type { CompositionRunner } from "@studix/workflow";
import type { SkillSandbox } from "./skill-sandbox.ts";

/*
 * The worker side of `composition.run`: the composition's files are copied into the job's skill sandbox (open
 * network, the workspace's media vendor keys, the enabled skills under /skills), the command runs in
 * /work/c, and every file it added or changed is stored back. Dependency and cache folders stay behind.
 */

const ROOT = "/work/c";
const STAMP = "/work/.composition-stamp";
const LOG_BYTES = 64 * 1024;
/** Folders a run may fill but never stores back (installs, caches, VCS). */
const SKIPPED = /(^|\/)(node_modules|\.git|\.cache|\.npm|__pycache__|\.venv)(\/|$)/;

export interface CompositionRunnerDeps {
  sandbox: SkillSandbox;
  storage: StorageAdapter;
  workDir: string;
  logger: Logger;
}

/** Every way a rendered file misses the requested output check; empty when it passes. */
export function compositionCheckProblems(
  check: CompositionCheck,
  probe: { width: number; height: number; durationMs: number; audioCodec?: string },
  loudness: LoudnessMeasurement | undefined,
): string[] {
  const problems: string[] = [];
  if (check.width !== undefined && probe.width !== check.width) {
    problems.push(`width ${probe.width}, expected ${check.width}`);
  }
  if (check.height !== undefined && probe.height !== check.height) {
    problems.push(`height ${probe.height}, expected ${check.height}`);
  }
  if (
    check.durationMs !== undefined &&
    Math.abs(probe.durationMs - check.durationMs) > check.durationToleranceMs
  ) {
    problems.push(
      `duration ${Math.round(probe.durationMs)} ms, expected ${check.durationMs} +/-${check.durationToleranceMs} ms`,
    );
  }
  if (check.audio && check.loudnessLufs === undefined) {
    if (!probe.audioCodec) problems.push("no audio track");
    else if (!loudness || !Number.isFinite(loudness.integratedLufs)) problems.push("audio is silent");
  }
  if (check.loudnessLufs !== undefined) {
    if (!probe.audioCodec) problems.push("no audio track");
    else if (!loudness || !Number.isFinite(loudness.integratedLufs)) problems.push("audio is silent");
    else {
      if (Math.abs(loudness.integratedLufs - check.loudnessLufs) > 2) {
        problems.push(`loudness ${loudness.integratedLufs} LUFS, expected ${check.loudnessLufs} +/-2`);
      }
      if (!(loudness.truePeakDbtp <= -1))
        problems.push(`true peak ${loudness.truePeakDbtp} dBTP, expected <= -1`);
    }
  }
  return problems;
}

function nameSome(paths: readonly string[], max = 10): string {
  return paths.length > max
    ? `${paths.slice(0, max).join(", ")} and ${paths.length - max} more`
    : paths.join(", ");
}

export function createCompositionRunner(deps: CompositionRunnerDeps): CompositionRunner {
  const log = deps.logger.child({ component: "composition-run" });
  return {
    async run(stage, request) {
      const { ctx, job, signal } = stage;
      const manifest = await loadCompositionManifest(deps.storage, ctx, request.compositionId);
      const host = join(deps.workDir, job.id, "composition");
      await mkdir(host, { recursive: true });
      const workspace = await deps.sandbox.forStage(stage).open(ctx, { taskId: `cmp-${job.id}`, signal });
      const box = workspace.sandbox;
      try {
        for (const file of manifest.files) {
          const { body } = await deps.storage.get(ctx, compositionFileKey(manifest.id, file.path));
          const bytes = Buffer.from(await new Response(body).arrayBuffer());
          await box.run(
            ["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", `${ROOT}/${file.path}`],
            {
              stdin: bytes,
              signal,
            },
          );
        }
        await box.run(["sh", "-c", `mkdir -p ${ROOT} && touch ${STAMP}`]);
        let output = "";
        const started = Date.now();
        const { exitCode } = await box.exec(request.command, {
          cwd: ROOT,
          signal,
          timeoutSeconds: request.timeoutSeconds,
          onData: (chunk) => {
            output = (output + chunk.toString("utf8")).slice(-LOG_BYTES);
          },
        });
        const durationMs = Date.now() - started;
        const listing = await box.run(["find", ROOT, "-type", "f", "-newer", STAMP, "-printf", "%s %P\\n"]);
        const paths: string[] = [];
        const tooBig: string[] = [];
        const badName: string[] = [];
        for (const line of listing.toString("utf8").split("\n")) {
          const sep = line.indexOf(" ");
          if (sep < 1) continue;
          const path = line.slice(sep + 1);
          if (SKIPPED.test(path)) continue;
          if (!CompositionPath.safeParse(path).success) badName.push(path);
          else if (Number(line.slice(0, sep)) > COMPOSITION_LIMITS.runFileBytes) tooBig.push(path);
          else paths.push(path);
        }
        if (badName.length > 0) {
          output += `\n[studix] not stored, invalid path: ${nameSome(badName)}`;
        }
        if (tooBig.length > 0) {
          output += `\n[studix] not stored, over ${COMPOSITION_LIMITS.runFileBytes} bytes: ${nameSome(tooBig)}`;
        }
        if (paths.length > COMPOSITION_LIMITS.runFiles) {
          output += `\n[studix] stored the first ${COMPOSITION_LIMITS.runFiles} of ${paths.length} changed files; not stored: ${nameSome(paths.slice(COMPOSITION_LIMITS.runFiles))}`;
        }
        // Refuse before storing anything: a run that cannot fit must leave the composition untouched.
        try {
          assertCompositionFits(
            compositionCountAfter(
              await loadCompositionManifest(deps.storage, ctx, manifest.id),
              paths.slice(0, COMPOSITION_LIMITS.runFiles),
            ),
          );
        } catch (err) {
          if (err instanceof StudixError && err.code === "VALIDATION") {
            throw new StudixError(
              "VALIDATION",
              `${err.message}; this run produced ${paths.length} changed files and stored none`,
              {
                retryable: false,
                suggestedAction: err.suggestedAction,
                details: { ...err.details, changedFiles: paths.length, exitCode, log: output.slice(-2000) },
              },
            );
          }
          throw err;
        }
        const storing = paths.slice(0, COMPOSITION_LIMITS.runFiles);
        // Refuse a run that would pass the file cap before any stored blob is overwritten.
        mergeManifest(
          await loadCompositionManifest(deps.storage, ctx, manifest.id),
          storing.map((path) => ({ path, bytes: 0, sha256: "", contentType: "" })),
        );
        const changed: CompositionFile[] = [];
        for (const [i, path] of storing.entries()) {
          const local = join(host, `f${i}`);
          await box.copyOut(`${ROOT}/${path}`, local);
          const { sha256, bytes } = await sha256File(local);
          const contentType = compositionContentType(path);
          await deps.storage.put(
            ctx,
            compositionFileKey(manifest.id, path),
            { filePath: local },
            {
              contentType,
              sha256,
            },
          );
          changed.push({ path, bytes, sha256, contentType });
        }
        // Re-read so a write made while the command ran is kept.
        const latest = await loadCompositionManifest(deps.storage, ctx, manifest.id);
        await saveCompositionManifest(deps.storage, ctx, mergeManifest(latest, changed));
        const result: CompositionRunResult = {
          exitCode,
          durationMs,
          log: output,
          changed,
        };
        if (request.check && exitCode === 0) {
          // Fonts live in the sandbox that rendered the file, so ask it before it closes. A probe that
          // fails to run says nothing about the fonts, so it never fails the check.
          let vietnameseFont: boolean | undefined = true;
          if (request.check.frames?.vietnamese) {
            vietnameseFont = await box
              .run(["sh", "-c", "fc-list ':lang=vi' family 2>/dev/null | head -n 1"], { signal })
              .then((out) => out.toString("utf8").trim().length > 0)
              .catch((err) => {
                if (err instanceof StudixError && err.code === "CANCELLED") throw err;
                return undefined;
              });
          }
          result.check = await check(request.check, paths, host, vietnameseFont);
        }
        log.info("composition run finished", { jobId: job.id, exitCode, changed: changed.length });
        return result;
      } finally {
        await workspace.close().catch(() => undefined);
        await rm(host, { recursive: true, force: true }).catch(() => undefined);
      }

      /** Frame checks plus a contact sheet stored beside the render, so the agent can look at what it made. */
      async function lookAtFrames(
        spec: CompositionCheck,
        local: string,
        durationMs: number,
        dir: string,
        vietnameseFont: boolean | undefined,
      ) {
        const frames = spec.frames as NonNullable<CompositionCheck["frames"]>;
        const options = { ffmpegPath: process.env.FFMPEG_PATH, signal, workDir: join(dir, "frames") };
        const seen = await checkFrames(local, durationMs, { ...frames, ...options });
        const problems = [...seen.problems];
        if (frames.vietnamese && vietnameseFont === false) {
          problems.push(
            "no installed system font covers Vietnamese in the render sandbox: accented text that relies on system fonts will render as empty boxes (fonts loaded with @font-face are not checked)",
          );
        }
        const sheet = join(dir, "contact-sheet.jpg");
        let bytes: number;
        try {
          bytes = await writeContactSheet(local, durationMs, frames.samples, sheet, options);
        } catch (err) {
          if (err instanceof StudixError && (err.code === "CANCELLED" || err.code === "TIMEOUT")) throw err;
          return { problems };
        }
        const { sha256 } = await sha256File(sheet);
        const stem = spec.path.replace(/\.[^./]+$/, "").replace(/\//g, "__");
        let path = `qa/${stem}-contact-sheet.jpg`;
        if (!CompositionPath.safeParse(path).success) path = `qa/contact-sheet-${sha256.slice(0, 12)}.jpg`;
        const contentType = "image/jpeg";
        const latest = await loadCompositionManifest(deps.storage, ctx, manifest.id);
        let merged: ReturnType<typeof mergeManifest>;
        try {
          merged = mergeManifest(latest, [{ path, bytes, sha256, contentType }]);
        } catch {
          // The composition is full: the check still reports, just without a sheet.
          return { problems };
        }
        await deps.storage.put(
          ctx,
          compositionFileKey(manifest.id, path),
          { filePath: sheet },
          { contentType, sha256 },
        );
        await saveCompositionManifest(deps.storage, ctx, merged);
        return { problems, contactSheet: path };
      }

      async function check(
        spec: CompositionCheck,
        written: string[],
        dir: string,
        vietnameseFont: boolean | undefined,
      ) {
        const local = join(dir, "check-target");
        // The stored copy: written by this run, or by an earlier one.
        const exists =
          written.includes(spec.path) ||
          (await loadCompositionManifest(deps.storage, ctx, manifest.id)).files.some(
            (f) => f.path === spec.path,
          );
        if (!exists) return { path: spec.path, passed: false, problems: [`${spec.path} does not exist`] };
        await deps.storage.download(ctx, compositionFileKey(manifest.id, spec.path), local);
        let probed: {
          probe: Awaited<ReturnType<FfmpegProbe["probe"]>>;
          loudness: LoudnessMeasurement | undefined;
          problems: string[];
        };
        try {
          const probe = await new FfmpegProbe({ ffprobePath: process.env.FFPROBE_PATH }).probe(local, signal);
          const loudness =
            (spec.loudnessLufs !== undefined || spec.audio) && probe.audioCodec
              ? await measureLoudness(local, { ffmpegPath: process.env.FFMPEG_PATH, signal })
              : undefined;
          const problems = compositionCheckProblems(spec, probe, loudness);
          probed = { probe, loudness, problems };
        } catch (err) {
          if (err instanceof StudixError && err.code === "CANCELLED") throw err;
          return { path: spec.path, passed: false, problems: [`not a playable media file: ${String(err)}`] };
        }
        // Frame and storage errors are not "unplayable": they surface as the errors they are.
        const { probe, loudness, problems } = probed;
        let contactSheet: string | undefined;
        if (spec.frames) {
          const seen = await lookAtFrames(spec, local, probe.durationMs, dir, vietnameseFont);
          problems.push(...seen.problems);
          contactSheet = seen.contactSheet;
        }
        return {
          path: spec.path,
          passed: problems.length === 0,
          problems,
          probe: { ...probe, ...(loudness ? { loudness } : {}) } as Record<string, unknown>,
          ...(contactSheet ? { contactSheet } : {}),
        };
      }
    },
  };
}
