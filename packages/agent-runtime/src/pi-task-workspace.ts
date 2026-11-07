import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { AgentInputFile, TenantContext } from "@studix/core";
import { StudixError } from "@studix/shared";
import {
  SANDBOX_INPUT_DIR,
  SANDBOX_OUTPUT_DIR,
  SANDBOX_SKILLS_DIR,
  type SandboxDriver,
  type SandboxLimits,
  type SandboxSession,
} from "./sandbox-docker.ts";
import {
  changedSkillBundles,
  materializeSkillBundles,
  type SkillBundleFile,
  type SkillBundleSource,
} from "./skill-bundle-source.ts";

/** A skill as the agent first sees it: name and description, with the path of its SKILL.md in the sandbox. */
export interface SandboxSkillEntry {
  name: string;
  description: string;
  /** Container path of SKILL.md, read on demand with the read tool. */
  location: string;
}

export interface PiTaskWorkspace {
  sandbox: SandboxSession;
  skills: SandboxSkillEntry[];
  /** Container paths of the task's input files, already in place under /work/in. */
  inputs: string[];
  /** Copies the task's results out of the sandbox to host paths (returned); called once after success. */
  collect(): Promise<string[]>;
  close(): Promise<void>;
}

/** Opens the sandbox of one tool-using task. Built per job stage by the worker. */
export interface PiTaskWorkspaceProvider {
  open(
    ctx: TenantContext,
    request: { taskId: string; signal: AbortSignal; inputFiles?: readonly AgentInputFile[] },
  ): Promise<PiTaskWorkspace>;
}

export interface PiTaskWorkspaceOptions {
  driver: SandboxDriver;
  /** Enabled skills of the tenant; omitted means the task runs without skills. */
  skills?: SkillBundleSource;
  /** The job's own provider keys (for example ELEVENLABS_API_KEY), resolved per tenant. */
  env(ctx: TenantContext): Promise<Record<string, string>>;
  limits: SandboxLimits;
  /** Host directory that receives the files under /work/out when the task succeeds. */
  outputDir: string;
  /** Parent of the host copies of the skills (default: OS temp). */
  scratchRoot?: string;
  /**
   * Stores the skills the agent edited under /skills, called from `collect` (so only after a successful run)
   * with each changed skill's full new file set. Omitted, edits are dropped with the sandbox.
   */
  storeSkillEdits?(
    ctx: TenantContext,
    edits: Array<{ name: string; files: SkillBundleFile[] }>,
  ): Promise<void>;
  /** Downloads one stored input file to a host path; without it a task with input files fails VALIDATION. */
  fetchInput?(ctx: TenantContext, storageKey: string, hostPath: string): Promise<void>;
  /** Caps on what `collect` copies out. */
  maxOutputFiles?: number;
}

const DEFAULT_MAX_OUTPUT_FILES = 50;
const MAX_INPUT_FILES = 20;
const INPUT_SEGMENT = /^[\w.-]{1,100}$/;

/** The container path of each input file; a path that could leave /work/in is refused. */
export function sandboxInputPaths(files: readonly AgentInputFile[]): string[] {
  if (files.length > MAX_INPUT_FILES) {
    throw new StudixError("VALIDATION", `A task takes at most ${MAX_INPUT_FILES} input files`, {
      retryable: false,
    });
  }
  const paths = files.map((f) => {
    const segments = f.path.split("/");
    const ok =
      segments.length <= 5 && segments.every((s) => INPUT_SEGMENT.test(s) && s !== "." && s !== "..");
    if (!ok) {
      throw new StudixError("VALIDATION", `Invalid input file path: ${f.path.slice(0, 200)}`, {
        retryable: false,
        suggestedAction: "Use a relative path such as builder/out.mp4.",
      });
    }
    return posix.join(SANDBOX_INPUT_DIR, f.path);
  });
  if (new Set(paths).size !== paths.length) {
    throw new StudixError("VALIDATION", "Two input files share a path", { retryable: false });
  }
  return paths;
}

/** What a sandboxed agent is told about its files: the inputs it was given, and that only /work/out is kept. */
export function sandboxFilesNote(inputs: readonly string[]): string {
  const kept = `Only files under ${SANDBOX_OUTPUT_DIR} are kept after the run; everything else is deleted.`;
  if (inputs.length === 0) return kept;
  const list = inputs.map((p) => `- ${p}`).join("\n");
  return `Input files (already in the sandbox; read them there, never download them):\n${list}\n${kept}`;
}

export function createPiTaskWorkspaceProvider(options: PiTaskWorkspaceOptions): PiTaskWorkspaceProvider {
  return {
    async open(ctx, request) {
      const inputFiles = request.inputFiles ?? [];
      const inputs = sandboxInputPaths(inputFiles);
      if (inputFiles.length > 0 && !options.fetchInput) {
        throw new StudixError("VALIDATION", "This worker cannot stage input files", { retryable: false });
      }
      const bundles = options.skills ? await options.skills.listEnabled(ctx) : [];
      const scratch = options.scratchRoot ?? tmpdir();
      if (bundles.length > 0) await mkdir(scratch, { recursive: true });
      const skillsDir = bundles.length > 0 ? await mkdtemp(join(scratch, "studix-skills-")) : undefined;
      let sandbox: SandboxSession | undefined;
      try {
        const mounted = skillsDir ? await materializeSkillBundles(bundles, skillsDir) : [];
        const env = await options.env(ctx);
        sandbox = await options.driver.open({
          taskId: request.taskId,
          env,
          ...(skillsDir ? { skillsDir } : {}),
          limits: options.limits,
          signal: request.signal,
        });
        const open = sandbox;
        if (inputFiles.length > 0 && options.fetchInput) {
          await mkdir(scratch, { recursive: true });
          const staging = await mkdtemp(join(scratch, "studix-in-"));
          try {
            for (const [i, file] of inputFiles.entries()) {
              const hostPath = join(staging, String(i));
              await options.fetchInput(ctx, file.storageKey, hostPath);
              await open.copyIn(hostPath, inputs[i] as string);
            }
          } finally {
            await rm(staging, { recursive: true, force: true });
          }
        }
        return {
          sandbox: open,
          inputs,
          skills: mounted.map((b) => ({
            name: b.name,
            description: b.description,
            location: posix.join(SANDBOX_SKILLS_DIR, b.name, "SKILL.md"),
          })),
          async collect() {
            const listing = await open.run([
              "find",
              SANDBOX_OUTPUT_DIR,
              "-maxdepth",
              "3",
              "-type",
              "f",
              "-size",
              "-2048M",
            ]);
            const files = listing
              .toString("utf8")
              .split("\n")
              .filter((f) => f.startsWith(`${SANDBOX_OUTPUT_DIR}/`))
              .slice(0, options.maxOutputFiles ?? DEFAULT_MAX_OUTPUT_FILES);
            await mkdir(options.outputDir, { recursive: true });
            const copied: string[] = [];
            for (const file of files) {
              const rel = posix.relative(SANDBOX_OUTPUT_DIR, file);
              // Flatten to one level so a crafted name cannot climb out of outputDir.
              const safe = rel.replace(/[^\w.-]+/g, "_");
              const target = join(options.outputDir, safe);
              await open.copyOut(file, target);
              copied.push(target);
            }
            if (skillsDir && options.storeSkillEdits) {
              const changed = await changedSkillBundles(mounted, skillsDir);
              if (changed.length > 0) {
                await options.storeSkillEdits(
                  ctx,
                  changed.map((c) => ({ name: c.bundle.name, files: c.files })),
                );
              }
            }
            return copied;
          },
          async close() {
            await open.close();
            if (skillsDir) await rm(skillsDir, { recursive: true, force: true });
          },
        };
      } catch (error) {
        await sandbox?.close().catch(() => undefined);
        if (skillsDir) await rm(skillsDir, { recursive: true, force: true });
        if (error instanceof StudixError) throw error;
        throw new StudixError("UNAVAILABLE", `The skill sandbox could not start: ${String(error)}`, {
          retryable: true,
          cause: error,
        });
      }
    },
  };
}
