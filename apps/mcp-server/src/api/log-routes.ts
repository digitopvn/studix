import { Router } from "express";
import type { AppDeps } from "../app-deps.ts";
import { LogQueryInput, LogTailInput, logService, tailJobProbe } from "../mcp/log-tools.ts";
import { parseBody, sessionOf } from "./api-context.ts";

/**
 * REST twin of `studix_query_logs` and `studix_tail_logs`: same input schemas, same service, same permission
 * (`logs:read`, workspace owners) and the same audit record. Bodies are the tool arguments; replies are the
 * tool's `data` without the MCP envelope.
 */
export function logRoutes(deps: AppDeps): Router {
  const router = Router();

  router.post("/query", async (req, res) => {
    const { ctx } = sessionOf(res);
    const input = parseBody(LogQueryInput, req.body, "logs query");
    res.json(await logService(deps).query(ctx, input));
  });

  router.post("/tail", async (req, res) => {
    const { ctx } = sessionOf(res);
    const input = parseBody(LogTailInput, req.body, "logs tail");
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    res.json(await logService(deps).tail(ctx, input, { job: tailJobProbe(deps), signal: controller.signal }));
  });

  return router;
}
