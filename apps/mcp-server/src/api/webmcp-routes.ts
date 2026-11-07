import { StudixError, toStudixError } from "@studix/shared";
import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../app-deps.ts";
import type { ArtifactUrlDeps } from "../artifact-urls.ts";
import { ASSET_MCP_TOOLS, ASSET_TOOL_NAMES } from "../mcp/asset-tools.ts";
import { NATIVE_TOOLS, type NativeTool } from "../mcp/native-tools.ts";
import { errorEnvelope, okEnvelope } from "../mcp/tool-envelope.ts";
import { parseBody, sessionOf } from "./api-context.ts";

/**
 * The MCP tools the dashboard also registers for in-browser agents (WebMCP). They are the same definitions as
 * `/mcp`, so names, schemas and behavior cannot drift; the browser calls them with the signed-in session.
 */
export const WEBMCP_TOOL_NAMES = [
  "studix_create_video",
  "studix_get_job",
  "studix_get_project",
  "studix_feedback",
  "studix_render",
  "studix_cancel_job",
  "studix_retry_job",
  ...Object.values(ASSET_TOOL_NAMES),
] as const;

function webTools(): NativeTool[] {
  const byName = new Map(
    ([...NATIVE_TOOLS, ...ASSET_MCP_TOOLS] as readonly NativeTool[]).map((t) => [t.name, t]),
  );
  return WEBMCP_TOOL_NAMES.flatMap((name) => byName.get(name) ?? []);
}

export function webmcpRoutes(deps: AppDeps, artifacts: ArtifactUrlDeps): Router {
  const router = Router();
  const tools = webTools();

  router.get("/webmcp/tools", (_req, res) => {
    res.json({
      tools: tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }),
        annotations: { readOnlyHint: t.readOnly, destructiveHint: t.destructive ?? false },
      })),
    });
  });

  router.post("/webmcp/tools/:name", async (req, res) => {
    const { ctx: tenant } = sessionOf(res);
    const def = tools.find((t) => t.name === req.params.name);
    if (!def) throw new StudixError("NOT_FOUND", "Unknown WebMCP tool");
    const traceId = crypto.randomUUID().replaceAll("-", "");
    // The reply is the same CallToolResult `/mcp` returns, so the browser hands it to the agent unchanged.
    try {
      const args = parseBody(def.input, req.body, def.name);
      const outcome = await def.run(
        { deps, artifacts, tenant, traceId, toolNames: [...WEBMCP_TOOL_NAMES] },
        args,
      );
      if (def.audited) {
        await deps.activity?.record(tenant, {
          name: `webmcp.${def.name}`,
          scope: outcome.scope,
          traceId,
          attributes: { tool: def.name, actorType: tenant.actor.type, actorId: tenant.actor.id },
        });
      }
      res.json(okEnvelope(outcome.data, outcome.next, traceId, outcome.images));
    } catch (e) {
      res.json(errorEnvelope(toStudixError(e), traceId));
    }
  });

  return router;
}
