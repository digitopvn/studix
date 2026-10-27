import { createLogger, isStudixError } from "@studix/shared";
import { loadWorkerPorts } from "./worker-ports.ts";
import { runWorkerProcess } from "./worker-process.ts";

/** Process entry: `tsx src/main.ts` (STUDIX_ROLE=worker). */
const logger = createLogger({ service: "studix-worker" });

runWorkerProcess({ resolvePorts: loadWorkerPorts, logger }).catch((err: unknown) => {
  logger.error("worker failed to start", {
    error: err instanceof Error ? err.message : String(err),
    ...(isStudixError(err) ? { code: err.code, suggestedAction: err.suggestedAction } : {}),
  });
  process.exit(1);
});
