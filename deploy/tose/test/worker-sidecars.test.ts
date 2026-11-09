import { describe, expect, it } from "vitest";
import { buildWorkerSidecars, runnerPort } from "../worker-sidecars.ts";

const image = `ghcr.io/digitopvn/studix-pi-runner@sha256:${"a".repeat(64)}`;
const base = { count: 2, image, registryCredentialId: "cred-1", cpu: "1.5", ram: "3" };

describe("buildWorkerSidecars", () => {
  it("builds one named, port-distinct runner per count with its own token key", () => {
    const sidecars = buildWorkerSidecars(base);
    expect(sidecars.map((s) => s.name)).toEqual(["pi-runner-1", "pi-runner-2"]);
    // The declared port is the probe listener (API port + 100); the API port is fixed by the args.
    expect(sidecars.map((s) => s.port)).toEqual([7171, 7172]);
    expect(sidecars.map((s) => s.args)).toEqual([
      ["--port", "7071"],
      ["--port", "7072"],
    ]);
    expect(sidecars[1]).toMatchObject({
      image,
      registry_credential_id: "cred-1",
      cpu: "1.5",
      ram: "3",
      health_path: "/healthz",
      run_as_user: 1000,
      env: [{ name: "STUDIX_RUNNER_TOKEN", from_env: "STUDIX_RUNNER_2_TOKEN" }],
    });
    expect(runnerPort(1)).toBe(7071);
  });

  it("omits the registry credential when none is given", () => {
    const [sidecar] = buildWorkerSidecars({ ...base, count: 1, registryCredentialId: undefined });
    expect(sidecar).not.toHaveProperty("registry_credential_id");
  });

  it.each([0, 4, 1.5, Number.NaN])("rejects runner count %s", (count) => {
    expect(() => buildWorkerSidecars({ ...base, count })).toThrow(/TOSE_WORKER_RUNNERS/);
  });

  it("rejects an image that is not pinned by digest", () => {
    expect(() => buildWorkerSidecars({ ...base, image: "ghcr.io/digitopvn/studix-pi-runner:abc" })).toThrow(
      /digest/,
    );
  });

  it("rejects non-positive cpu or ram", () => {
    expect(() => buildWorkerSidecars({ ...base, cpu: "0" })).toThrow(/TOSE_RUNNER_CPU/);
    expect(() => buildWorkerSidecars({ ...base, ram: "abc" })).toThrow(/TOSE_RUNNER_RAM/);
  });
});
