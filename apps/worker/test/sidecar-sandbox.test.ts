import { testTenant } from "@studix/core/testing";
import type { Logger } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { createMediaExecRunner, loadMediaExecSettings } from "../src/media-exec-runner.ts";
import { assertSidecarWorkspace, loadSidecarSettings } from "../src/sidecar-sandbox-settings.ts";
import { loadSandboxSettings } from "../src/skill-sandbox.ts";

const TOKEN = "k".repeat(32);
const base = {
  STUDIX_SANDBOX: "sidecar",
  STUDIX_SANDBOX_RUNNERS: "http://127.0.0.1:7071, http://localhost:7072",
  STUDIX_RUNNER_1_TOKEN: TOKEN,
  STUDIX_RUNNER_2_TOKEN: TOKEN,
  STUDIX_SANDBOX_SIDECAR_WORKSPACES: "ws_trusted",
};

describe("sidecar sandbox settings", () => {
  it("parses runners, tokens and the workspace allowlist; docker settings stay without a sidecar block", () => {
    const settings = loadSandboxSettings(base);
    expect(settings?.sidecar?.runners).toEqual([
      { url: "http://127.0.0.1:7071", token: TOKEN },
      { url: "http://localhost:7072", token: TOKEN },
    ]);
    expect([...(settings?.sidecar?.workspaces ?? [])]).toEqual(["ws_trusted"]);
    expect(loadSandboxSettings({ STUDIX_SANDBOX: "docker" })).not.toHaveProperty("sidecar");
    expect(loadSandboxSettings({})).toBeUndefined();
  });

  it.each([
    [{ STUDIX_SANDBOX_RUNNERS: "https://127.0.0.1:7071" }, "STUDIX_SANDBOX_RUNNERS"],
    [{ STUDIX_SANDBOX_RUNNERS: "http://10.0.0.5:7071" }, "STUDIX_SANDBOX_RUNNERS"],
    [{ STUDIX_SANDBOX_RUNNERS: "http://127.0.0.1" }, "STUDIX_SANDBOX_RUNNERS"],
    [{ STUDIX_SANDBOX_RUNNERS: "" }, "STUDIX_SANDBOX_RUNNERS"],
    [{ STUDIX_RUNNER_2_TOKEN: undefined }, "STUDIX_RUNNER_2_TOKEN"],
    [{ STUDIX_RUNNER_1_TOKEN: "short-secret-value" }, "STUDIX_RUNNER_1_TOKEN"],
    [{ STUDIX_SANDBOX_SIDECAR_WORKSPACES: "" }, "STUDIX_SANDBOX_SIDECAR_WORKSPACES"],
    [{ STUDIX_SANDBOX_SIDECAR_WORKSPACES: "*" }, "STUDIX_SANDBOX_SIDECAR_WORKSPACES"],
  ])("refuses %o naming %s, never the value", (override, variable) => {
    const error = (() => {
      try {
        loadSidecarSettings({ ...base, ...override });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error).toMatchObject({ code: "VALIDATION", message: expect.stringContaining(variable) });
    expect(JSON.stringify(error) + error?.message).not.toContain("short-secret-value");
    expect(error?.message).not.toContain("10.0.0.5");
  });

  it("lets only allowlisted workspaces open the runner", () => {
    const settings = loadSidecarSettings(base);
    const trusted = { ...testTenant(), workspaceId: "ws_trusted" };
    const other = { ...testTenant(), workspaceId: "ws_other" };
    expect(() => assertSidecarWorkspace(settings, trusted)).not.toThrow();
    expect(() => assertSidecarWorkspace(settings, other)).toThrow(
      expect.objectContaining({
        code: "FORBIDDEN",
        retryable: false,
        message: "The skill runner is limited to trusted workspaces on this server",
      }),
    );
  });
});

describe("media.exec on the sidecar backend", () => {
  it("fails every job UNAVAILABLE without building a docker driver", async () => {
    const sandbox = loadSandboxSettings(base);
    if (!sandbox) throw new Error("expected settings");
    const runner = createMediaExecRunner({
      sandbox,
      settings: loadMediaExecSettings({}),
      workDir: "/nonexistent",
      storage: {} as never,
      assets: {} as never,
      logger: {} as Logger,
    });
    await expect(runner.run({} as never, {} as never)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      retryable: false,
      message: expect.stringContaining("STUDIX_SANDBOX=sidecar"),
      suggestedAction: expect.stringContaining("STUDIX_SANDBOX=docker"),
    });
  });
});

describe("sidecar readiness report", () => {
  it("keeps runner errors and addresses out of /readyz, and hashes workspaces like the app", async () => {
    const { summarizeRunnerHealth } = await import("../src/sidecar-runner-health.ts");
    const { workspaceHash } = await import("../src/skill-sandbox.ts");
    const status = summarizeRunnerHealth([
      {
        runner: 1,
        url: "http://127.0.0.1:7071",
        ok: false,
        error: "Skill runner 1 at http://127.0.0.1:7071 refused",
      },
    ]);
    expect(status).toMatchObject({ backend: "sidecar", runners: 1, ready: 0 });
    expect(JSON.stringify(status)).not.toContain("127.0.0.1");
    const { createHash } = await import("node:crypto");
    expect(workspaceHash("ws_x")).toBe(createHash("sha256").update("ws_x").digest("hex").slice(0, 16));
  });
});
