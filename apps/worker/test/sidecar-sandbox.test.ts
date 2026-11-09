import { testTenant } from "@studix/core/testing";
import type { Logger } from "@studix/shared";
import { describe, expect, it, vi } from "vitest";
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
    [{ STUDIX_SANDBOX_SIDECAR_WORKSPACES: "ws_*" }, "STUDIX_SANDBOX_SIDECAR_WORKSPACES"],
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

describe("sidecar allowlist of every workspace", () => {
  it("opens the runners to any workspace with * alone", () => {
    const settings = loadSidecarSettings({ ...base, STUDIX_SANDBOX_SIDECAR_WORKSPACES: " * " });
    expect(settings.workspaces).toBe("all");
    expect(() =>
      assertSidecarWorkspace(settings, { ...testTenant(), workspaceId: "ws_anyone" }),
    ).not.toThrow();
  });

  it("refuses * mixed with workspace ids", () => {
    expect(() => loadSidecarSettings({ ...base, STUDIX_SANDBOX_SIDECAR_WORKSPACES: "*,ws_trusted" })).toThrow(
      expect.objectContaining({ code: "VALIDATION", message: expect.stringContaining("mixes *") }),
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

  it("logs again when runners that were down at startup become ready", async () => {
    const { startSidecarRunnerMonitor } = await import("../src/sidecar-runner-health.ts");
    const { loadSidecarSettings } = await import("../src/sidecar-sandbox-settings.ts");
    let up = false;
    const fakeFetch = (async () => {
      if (!up) throw new TypeError("fetch failed");
      return new Response(
        JSON.stringify({ protocol: 1, version: "v1", busy: false, toolchain: {}, startedAt: "" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const lines: Array<[string, Record<string, unknown>]> = [];
    const record = (msg: string, fields?: Record<string, unknown>) => void lines.push([msg, fields ?? {}]);
    const logger = { debug: record, info: record, warn: record, error: record } as unknown as Logger;
    const monitor = startSidecarRunnerMonitor(loadSidecarSettings(base), logger, {
      fetch: fakeFetch,
      attempts: 1,
      refreshMs: 0,
    });
    const checked = () => lines.filter(([m]) => m === "skill runners checked").map(([, f]) => f.ready);
    await monitor.started;
    expect(checked()).toEqual([0]);
    up = true;
    monitor.status();
    await vi.waitFor(() => expect(monitor.status()).toMatchObject({ ready: 2 }));
    expect(checked()).toEqual([0, 2]);
    // A refresh that changes nothing logs nothing.
    monitor.status();
    await new Promise((r) => setTimeout(r, 20));
    monitor.status();
    expect(checked()).toEqual([0, 2]);
    monitor.stop();
  });

  it("reports a runner on another protocol version as down, with the reason in the log only", async () => {
    const { startSidecarRunnerMonitor } = await import("../src/sidecar-runner-health.ts");
    const { loadSidecarSettings } = await import("../src/sidecar-sandbox-settings.ts");
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({ protocol: 99, version: "old", busy: false, toolchain: {}, startedAt: "" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )) as unknown as typeof fetch;
    const lines: Array<[string, string, Record<string, unknown>]> = [];
    const at = (level: string) => (msg: string, fields?: Record<string, unknown>) =>
      void lines.push([level, msg, fields ?? {}]);
    const logger = {
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
    } as unknown as Logger;
    const monitor = startSidecarRunnerMonitor(loadSidecarSettings(base), logger, {
      fetch: fakeFetch,
      attempts: 1,
    });
    await monitor.started;
    const [level, , fields] = lines.find(([, m]) => m === "skill runners checked") ?? [];
    expect(level).toBe("warn");
    expect(fields).toMatchObject({ ready: 0, runners: 2 });
    expect(fields?.down).toHaveLength(2);
    for (const down of (fields?.down ?? []) as Array<{ error: string }>)
      expect(down.error).toMatch(/protocol 99/);
    expect(monitor.status()).toMatchObject({
      ready: 0,
      versions: [],
      reason: expect.stringContaining("No skill runner is ready"),
    });
    expect(JSON.stringify(monitor.status())).not.toContain("protocol 99");
    monitor.stop();
  });

  it("stays silent on refreshes before the startup probe has reported", async () => {
    const { startSidecarRunnerMonitor } = await import("../src/sidecar-runner-health.ts");
    const { loadSidecarSettings } = await import("../src/sidecar-sandbox-settings.ts");
    const lines: string[] = [];
    const record = (msg: string) => void lines.push(msg);
    const logger = { debug: record, info: record, warn: record, error: record } as unknown as Logger;
    const fakeFetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const monitor = startSidecarRunnerMonitor(loadSidecarSettings(base), logger, {
      fetch: fakeFetch,
      attempts: 3,
      intervalMs: 30,
      refreshMs: 0,
    });
    monitor.status();
    await new Promise((r) => setTimeout(r, 10));
    monitor.status();
    expect(lines.filter((m) => m === "skill runners checked")).toHaveLength(0);
    await monitor.started;
    expect(lines.filter((m) => m === "skill runners checked")).toHaveLength(1);
    monitor.stop();
  });
});
