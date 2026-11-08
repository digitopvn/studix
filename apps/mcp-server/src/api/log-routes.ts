import { Router } from "express";
import type { AppDeps } from "../app-deps.ts";
import type { ArtifactUrlDeps } from "../artifact-urls.ts";
import { LOG_MCP_TOOLS, LOG_TOOL_NAMES } from "../mcp/log-tools.ts";
import { parseBody, sessionOf } from "./api-context.ts";

/**
 * REST form of the log tools: the same definitions `/mcp` and WebMCP run, so arguments, limits, redaction and
 * the audit record cannot differ. Owner role only (checked by the log service). POST because the filter set is
 * a body, and `tail` waits for new events.
 */
export function logRoutes(deps: AppDeps, artifacts: ArtifactUrlDeps): Router {
  const router = Router();
  const routes = [
    ["/logs/query", LOG_TOOL_NAMES.query],
    ["/logs/tail", LOG_TOOL_NAMES.tail],
  ] as const;
  for (const [path, name] of routes) {
    const def = LOG_MCP_TOOLS.find((t) => t.name === name);
    if (!def) continue;
    router.post(path, async (req, res) => {
      const { ctx: tenant } = sessionOf(res);
      const abort = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) abort.abort();
      });
      const args = parseBody(def.input, req.body, name);
      const outcome = await def.run(
        {
          deps,
          artifacts,
          tenant,
          traceId: crypto.randomUUID().replaceAll("-", ""),
          toolNames: [],
          signal: abort.signal,
        },
        // The tool definitions share one run signature; the schema above is the one for this path.
        args as never,
      );
      res.json(outcome.data);
    });
  }
  return router;
}
