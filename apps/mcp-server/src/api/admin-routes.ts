import { assertPermission } from "@studix/core";
import { StudixError } from "@studix/shared";
import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../app-deps.ts";
import type { ConnectorAdmin } from "../ports.ts";
import { idParam, parseBody, sessionOf } from "./api-context.ts";

const AddConnectorBody = z
  .object({
    name: z
      .string()
      .trim()
      .regex(
        /^[a-z][a-z0-9-]{1,39}$/,
        "2-40 chars: lowercase letters, digits and '-', starting with a letter",
      ),
    url: z
      .url()
      .max(2048)
      .refine((v) => /^https?:\/\//.test(v), "must be an http(s) URL"),
    /** Name of an operator-held credential (`STUDIX_CONNECTOR_SECRET_<NAME>`), never the secret value. */
    secretRef: z
      .string()
      .regex(/^[A-Za-z0-9:_./-]{1,200}$/)
      .optional(),
    /** Tools the workspace may use; without it the connector is registered but no tool is granted. */
    toolPolicy: z
      .object({
        allow: z.array(z.string().min(1).max(100)).max(100).optional(),
        deny: z.array(z.string().min(1).max(100)).max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Workspace API keys (session-authenticated; the key secret is returned only by create). */
export function apiKeyRoutes(deps: AppDeps): Router {
  const router = Router();
  router.get("/", async (_req, res) => {
    res.json({ items: await deps.apiKeys.list(sessionOf(res).ctx) });
  });
  router.post("/", async (req, res) => {
    // Shape validation happens inside the service (single source of truth for key requests).
    const created = await deps.apiKeys.create(sessionOf(res).ctx, req.body ?? {});
    res.status(201).set("Cache-Control", "no-store").json(created);
  });
  router.delete("/:keyId", async (req, res) => {
    res.json(await deps.apiKeys.revoke(sessionOf(res).ctx, idParam(req, "keyId")));
  });
  return router;
}

function requireConnectors(deps: AppDeps): ConnectorAdmin {
  if (!deps.connectors) {
    throw new StudixError("UNAVAILABLE", "Connectors are not enabled on this server", {
      retryable: false,
      suggestedAction: "Ask the operator to enable the MCP gateway.",
    });
  }
  return deps.connectors;
}

/**
 * Connector administration delegated to the gateway's ConnectorAdmin. The app checks the caller's role;
 * URL policy (SSRF, rebinding) and tenancy are enforced by the gateway implementation.
 */
export function connectorRoutes(deps: AppDeps): Router {
  const router = Router();
  router.get("/", async (_req, res) => {
    const { ctx } = sessionOf(res);
    assertPermission(ctx, "workspace:read");
    res.json({ items: await requireConnectors(deps).list(ctx) });
  });
  router.post("/", async (req, res) => {
    const { ctx } = sessionOf(res);
    assertPermission(ctx, "member:manage");
    const body = parseBody(AddConnectorBody, req.body, "connector");
    res.status(201).json(await requireConnectors(deps).add(ctx, body));
  });
  router.post("/:connectorId/test", async (req, res) => {
    const { ctx } = sessionOf(res);
    assertPermission(ctx, "member:manage");
    res.json(await requireConnectors(deps).test(ctx, idParam(req, "connectorId")));
  });
  router.post("/:connectorId/disable", async (req, res) => {
    const { ctx } = sessionOf(res);
    assertPermission(ctx, "member:manage");
    res.json(await requireConnectors(deps).disable(ctx, idParam(req, "connectorId")));
  });
  return router;
}
