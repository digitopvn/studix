import { StudixError } from "@studix/shared";
import type { WorkerPorts } from "./wiring.ts";
import type { WorkerSettings } from "./worker-settings.ts";

/**
 * Adapter registry for the standalone worker entry. This build of the worker registers no planner,
 * renderer or storage adapter, so it refuses to start instead of running with fakes. Deployments wire
 * the concrete adapters (DecisionRouter planner, HyperFrames renderer, S3 storage) here.
 */
export async function loadWorkerPorts(_settings: WorkerSettings): Promise<WorkerPorts> {
  throw new StudixError(
    "UNAVAILABLE",
    "No planner, renderer or storage adapter is registered in this worker build",
    {
      retryable: false,
      suggestedAction:
        "Wire the adapters in apps/worker/src/worker-ports.ts, or embed the worker via runWorkerProcess().",
    },
  );
}
