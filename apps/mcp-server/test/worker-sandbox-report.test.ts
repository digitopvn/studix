import { describe, expect, it } from "vitest";
import { fetchWorkerSandbox } from "../src/worker-sandbox-report.ts";

const answer = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;

describe("worker sandbox report", () => {
  it("reports a sidecar backend with no ready runner as unavailable, with the worker's reason", async () => {
    const report = await fetchWorkerSandbox(
      "http://worker:8081",
      answer({ sandbox: { backend: "sidecar", runners: 3, ready: 0, reason: "No skill runner is ready" } }),
    );
    expect(report).toEqual({
      backend: "sidecar",
      available: false,
      runners: 3,
      ready: 0,
      reason: "No skill runner is ready",
    });
  });

  it("treats docker as available and ignores a missing or unknown block", async () => {
    expect(await fetchWorkerSandbox("http://w", answer({ sandbox: { backend: "docker" } }))).toEqual({
      backend: "docker",
      available: true,
    });
    expect(await fetchWorkerSandbox("http://w", answer({ status: "ok" }))).toBeUndefined();
    expect(await fetchWorkerSandbox("http://w", answer({ sandbox: { backend: "x" } }))).toBeUndefined();
  });
});
