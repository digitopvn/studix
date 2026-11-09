import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fetchWorkerSandbox, reportForWorkspace } from "../src/worker-sandbox-report.ts";

const answer = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
const hash = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 16);

describe("worker sandbox report", () => {
  it("reports no ready runner as unavailable with a fixed reason, never the worker's text", async () => {
    const snapshot = await fetchWorkerSandbox(
      "http://worker:8081",
      answer({
        sandbox: {
          backend: "sidecar",
          runners: 3,
          ready: 0,
          reason: "runner at http://127.0.0.1:7071 refused",
          workspaceHashes: [hash("ws_a")],
        },
      }),
    );
    const report = reportForWorkspace(snapshot!, "ws_a");
    expect(report).toMatchObject({ backend: "sidecar", available: false, runners: 3, ready: 0 });
    expect(report.reason).toMatch(/No skill runner is ready/);
    expect(JSON.stringify(report)).not.toContain("127.0.0.1");
  });

  it("is unavailable for a workspace outside the allowlist, available for one inside", async () => {
    const snapshot = await fetchWorkerSandbox(
      "http://w",
      answer({ sandbox: { backend: "sidecar", runners: 2, ready: 2, workspaceHashes: [hash("ws_a")] } }),
    );
    expect(reportForWorkspace(snapshot!, "ws_a")).toEqual({
      backend: "sidecar",
      available: true,
      runners: 2,
      ready: 2,
    });
    const other = reportForWorkspace(snapshot!, "ws_b");
    expect(other).toMatchObject({ backend: "sidecar", available: false });
    expect(other.reason).toMatch(/not enabled for this workspace/);
    expect(other).not.toHaveProperty("ready");
  });

  it("allows every workspace when the worker reports no hashes (allowlist *), but none for an empty list", async () => {
    const open = await fetchWorkerSandbox(
      "http://w",
      answer({ sandbox: { backend: "sidecar", runners: 2, ready: 2 } }),
    );
    expect(reportForWorkspace(open!, "ws_anyone")).toEqual({
      backend: "sidecar",
      available: true,
      runners: 2,
      ready: 2,
    });
    const none = await fetchWorkerSandbox(
      "http://w",
      answer({ sandbox: { backend: "sidecar", runners: 2, ready: 2, workspaceHashes: [] } }),
    );
    expect(reportForWorkspace(none!, "ws_anyone")).toMatchObject({ available: false });
  });

  it("treats docker as available and ignores a missing or unknown block", async () => {
    const docker = await fetchWorkerSandbox("http://w", answer({ sandbox: { backend: "docker" } }));
    expect(reportForWorkspace(docker!, "ws_a")).toEqual({ backend: "docker", available: true });
    expect(await fetchWorkerSandbox("http://w", answer({ status: "ok" }))).toBeUndefined();
    expect(await fetchWorkerSandbox("http://w", answer({ sandbox: { backend: "x" } }))).toBeUndefined();
  });
});
