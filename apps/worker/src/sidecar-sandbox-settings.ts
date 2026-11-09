import type { SidecarRunnerConfig } from "@studix/agent-runtime";
import type { TenantContext } from "@studix/core";
import { StudixError } from "@studix/shared";

/*
 * Settings of the sidecar skill sandbox (STUDIX_SANDBOX=sidecar, docs/decisions/0025-sidecar-skill-runner.md):
 * pi-runner containers in the worker's own Pod, reached over loopback only. Errors name the variable, never
 * its value, because a token or a URL list may be pasted into a support ticket from them.
 */

export interface SidecarSettings {
  runners: SidecarRunnerConfig[];
  /** Workspace ids allowed to run tasks on the runners; the runners cannot cut egress, so access is opt-in. */
  workspaces: ReadonlySet<string>;
}

/** TOSE allows three sidecars; a few more leave room for other hosts without inviting misconfiguration. */
const MAX_RUNNERS = 8;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MIN_TOKEN_CHARS = 32;
const WORKSPACE_ID = /^[\w-]{1,100}$/;

function invalid(variable: string, message: string, suggestedAction: string): StudixError {
  return new StudixError("VALIDATION", `Invalid sandbox configuration: ${variable} ${message}`, {
    retryable: false,
    details: { issues: [{ variable, message }] },
    suggestedAction,
  });
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Parses STUDIX_SANDBOX_RUNNERS, STUDIX_RUNNER_<n>_TOKEN and STUDIX_SANDBOX_SIDECAR_WORKSPACES. */
export function loadSidecarSettings(env: NodeJS.ProcessEnv): SidecarSettings {
  const urls = list(env.STUDIX_SANDBOX_RUNNERS);
  if (urls.length === 0 || urls.length > MAX_RUNNERS) {
    throw invalid(
      "STUDIX_SANDBOX_RUNNERS",
      `must list 1-${MAX_RUNNERS} runner URLs`,
      "Set STUDIX_SANDBOX_RUNNERS to the pi-runner sidecars, e.g. http://127.0.0.1:7071,http://127.0.0.1:7072.",
    );
  }
  const runners = urls.map((raw, i): SidecarRunnerConfig => {
    const n = i + 1;
    let url: URL | undefined;
    try {
      url = new URL(raw);
    } catch {
      url = undefined;
    }
    const plain =
      url &&
      url.protocol === "http:" &&
      LOOPBACK.has(url.hostname) &&
      url.port !== "" &&
      !url.username &&
      !url.password &&
      (url.pathname === "/" || url.pathname === "") &&
      !url.search &&
      !url.hash;
    if (!url || !plain) {
      throw invalid(
        "STUDIX_SANDBOX_RUNNERS",
        `entry ${n} must be http://127.0.0.1:<port> (or localhost, [::1])`,
        "Runners are sidecars in the worker's Pod; list them by loopback address and port only.",
      );
    }
    const tokenVar = `STUDIX_RUNNER_${n}_TOKEN`;
    const token = env[tokenVar]?.trim() ?? "";
    if (token.length < MIN_TOKEN_CHARS) {
      throw invalid(
        tokenVar,
        token ? `must be at least ${MIN_TOKEN_CHARS} characters` : "is required",
        `Set ${tokenVar} to the STUDIX_RUNNER_TOKEN of runner ${n}.`,
      );
    }
    return { url: `${url.protocol}//${url.host}`, token };
  });
  if (new Set(runners.map((r) => r.url)).size !== runners.length) {
    throw invalid("STUDIX_SANDBOX_RUNNERS", "lists a runner twice", "List each runner address once.");
  }
  const workspaces = list(env.STUDIX_SANDBOX_SIDECAR_WORKSPACES);
  const bad = workspaces.findIndex((w) => !WORKSPACE_ID.test(w));
  if (workspaces.length === 0 || bad >= 0) {
    throw invalid(
      "STUDIX_SANDBOX_SIDECAR_WORKSPACES",
      workspaces.length === 0 ? "is required" : `entry ${bad + 1} is not a workspace id (no wildcards)`,
      "List the ids of the trusted workspaces that may run skill tasks on the sidecar runners.",
    );
  }
  return { runners, workspaces: new Set(workspaces) };
}

/** The sidecar runners keep open egress, so only allowlisted workspaces may open one. No other backend is tried. */
export function assertSidecarWorkspace(settings: SidecarSettings, ctx: TenantContext): void {
  if (settings.workspaces.has(ctx.workspaceId)) return;
  throw new StudixError("FORBIDDEN", "The skill runner is limited to trusted workspaces on this server", {
    retryable: false,
    suggestedAction:
      "Ask the operator to add this workspace to STUDIX_SANDBOX_SIDECAR_WORKSPACES, or run the job with payload.agentMode 'host'.",
  });
}
