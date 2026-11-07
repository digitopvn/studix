import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { TenantContext } from "@studix/core";
import { StudixError } from "@studix/shared";
import {
  SANDBOX_OUTPUT_DIR,
  SANDBOX_SKILLS_DIR,
  type SandboxDriver,
  type SandboxLimits,
  type SandboxSession,
} from "./sandbox-docker.ts";
import { materializeSkillBundles, type SkillBundleSource } from "./skill-bundle-source.ts";

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
  /** Copies the task's results out of the sandbox to host paths (returned); called once after success. */
  collect(): Promise<string[]>;
  close(): Promise<void>;
}

/** Opens the sandbox of one tool-using task. Built per job stage by the worker. */
export interface PiTaskWorkspaceProvider {
  open(ctx: TenantContext, request: { taskId: string; signal: AbortSignal }): Promise<PiTaskWorkspace>;
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
  /** Caps on what `collect` copies out. */
  maxOutputFiles?: number;
}

const DEFAULT_MAX_OUTPUT_FILES = 50;

export function createPiTaskWorkspaceProvider(options: PiTaskWorkspaceOptions): PiTaskWorkspaceProvider {
  return {
    async open(ctx, request) {
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
        return {
          sandbox: open,
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
