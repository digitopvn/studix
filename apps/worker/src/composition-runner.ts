import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  COMPOSITION_LIMITS,
  type CompositionCheck,
  type CompositionFile,
  CompositionPath,
  type CompositionRunResult,
  compositionContentType,
  compositionFileKey,
  loadCompositionManifest,
  mergeManifest,
  type StorageAdapter,
  saveCompositionManifest,
} from "@studix/core";
import { FfmpegProbe, type LoudnessMeasurement, measureLoudness } from "@studix/renderers";
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
        const listing = await box.run([
          "find",
          ROOT,
          "-type",
          "f",
          "-newer",
          STAMP,
          "-size",
          `-${Math.floor(COMPOSITION_LIMITS.runFileBytes / 1024)}k`,
          "-printf",
          "%P\\n",
        ]);
        const paths = listing
          .toString("utf8")
          .split("\n")
          .filter((p) => p && !SKIPPED.test(p) && CompositionPath.safeParse(p).success);
        if (paths.length > COMPOSITION_LIMITS.runFiles) {
          output += `\n[studix] stored the first ${COMPOSITION_LIMITS.runFiles} of ${paths.length} changed files`;
        }
        const changed: CompositionFile[] = [];
        for (const [i, path] of paths.slice(0, COMPOSITION_LIMITS.runFiles).entries()) {
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
          stdout: output,
          stderr: output,
          changed,
        };
        if (request.check && exitCode === 0) result.check = await check(request.check, paths, host);
        log.info("composition run finished", { jobId: job.id, exitCode, changed: changed.length });
        return result;
      } finally {
        await workspace.close().catch(() => undefined);
        await rm(host, { recursive: true, force: true }).catch(() => undefined);
      }

      async function check(spec: CompositionCheck, written: string[], dir: string) {
        const local = join(dir, "check-target");
        // The stored copy: written by this run, or by an earlier one.
        const exists =
          written.includes(spec.path) ||
          (await loadCompositionManifest(deps.storage, ctx, manifest.id)).files.some(
            (f) => f.path === spec.path,
          );
        if (!exists) return { path: spec.path, passed: false, problems: [`${spec.path} does not exist`] };
        await deps.storage.download(ctx, compositionFileKey(manifest.id, spec.path), local);
        try {
          const probe = await new FfmpegProbe({ ffprobePath: process.env.FFPROBE_PATH }).probe(local, signal);
          const loudness =
            spec.loudnessLufs !== undefined && probe.audioCodec
              ? await measureLoudness(local, { ffmpegPath: process.env.FFMPEG_PATH, signal })
              : undefined;
          const problems = compositionCheckProblems(spec, probe, loudness);
          return {
            path: spec.path,
            passed: problems.length === 0,
            problems,
            probe: { ...probe, ...(loudness ? { loudness } : {}) } as Record<string, unknown>,
          };
        } catch (err) {
          if (err instanceof StudixError && err.code === "CANCELLED") throw err;
          return { path: spec.path, passed: false, problems: [`not a playable media file: ${String(err)}`] };
        }
      }
    },
  };
}
