import { listPiCatalog } from "@studix/agent-runtime";
import type {
  ModelPreferenceService,
  PreviewInput,
  ProviderConnectionService,
  SaveApiKeyInput,
} from "@studix/auth";
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
    /** Reference to an operator-held credential (`env:STUDIX_CONNECTOR_SECRET_<NAME>`), never the value. */
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

function requireProviders(deps: AppDeps): ProviderConnectionService {
  if (!deps.providers) {
    throw new StudixError("UNAVAILABLE", "AI provider connections are not enabled on this server", {
      retryable: false,
    });
  }
  return deps.providers;
}

function requireModels(deps: AppDeps): ModelPreferenceService {
  if (!deps.modelPreferences) {
    throw new StudixError("UNAVAILABLE", "Model selection is not enabled on this server", {
      retryable: false,
    });
  }
  return deps.modelPreferences;
}

/**
 * The body of an Anthropic-only route; a `provider` field cannot redirect it to another provider. The
 * service parses the whole body with zod, so the cast only names the shape it will be checked against.
 */
function anthropicBody(body: unknown): SaveApiKeyInput {
  return { ...(body && typeof body === "object" ? body : {}), provider: "anthropic" } as SaveApiKeyInput;
}

/**
 * Outbound AI provider credentials (Anthropic). Permission checks per owner live in the service;
 * keys are accepted in request bodies only and every response is `no-store` and key-free.
 */
export function providerRoutes(deps: AppDeps): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/anthropic", async (_req, res) => {
    const overview = await requireProviders(deps).overview(sessionOf(res).ctx);
    res.json({ ...overview, claudePlanner: deps.claudePlanner === true });
  });
  router.post("/anthropic/api-keys", async (req, res) => {
    res
      .status(201)
      .json(await requireProviders(deps).saveApiKey(sessionOf(res).ctx, anthropicBody(req.body)));
  });
  // Self-hosted only (STUDIX_CLAUDE_SUBSCRIPTION): the caller's own `claude setup-token` output.
  router.post("/anthropic/subscription", async (req, res) => {
    res
      .status(201)
      .json(await requireProviders(deps).connectSubscription(sessionOf(res).ctx, req.body ?? {}));
  });
  router.put("/anthropic/api-keys/:connectionId", async (req, res) => {
    const id = idParam(req, "connectionId");
    res.json(await requireProviders(deps).rotateApiKey(sessionOf(res).ctx, id, req.body ?? {}));
  });
  router.post("/anthropic/api-keys/:connectionId/test", async (req, res) => {
    res.json(await requireProviders(deps).test(sessionOf(res).ctx, idParam(req, "connectionId")));
  });
  router.delete("/anthropic/api-keys/:connectionId", async (req, res) => {
    res.json(await requireProviders(deps).remove(sessionOf(res).ctx, idParam(req, "connectionId")));
  });

  // Every provider the Pi runtime can use, from the pinned SDK catalog; no credentials involved.
  router.get("/catalog", async (_req, res) => {
    assertPermission(sessionOf(res).ctx, "workspace:read");
    res.json({ providers: listPiCatalog() });
  });
  router.get("/connections", async (_req, res) => {
    res.json(await requireProviders(deps).list(sessionOf(res).ctx));
  });
  router.post("/connections", async (req, res) => {
    res.status(201).json(await requireProviders(deps).saveApiKey(sessionOf(res).ctx, req.body ?? {}));
  });
  router.put("/connections/:connectionId", async (req, res) => {
    const id = idParam(req, "connectionId");
    res.json(await requireProviders(deps).rotateApiKey(sessionOf(res).ctx, id, req.body ?? {}));
  });
  router.put("/connections/:connectionId/runtimes", async (req, res) => {
    const id = idParam(req, "connectionId");
    res.json(await requireProviders(deps).setRuntimes(sessionOf(res).ctx, id, req.body ?? {}));
  });
  router.post("/connections/:connectionId/test", async (req, res) => {
    res.json(await requireProviders(deps).test(sessionOf(res).ctx, idParam(req, "connectionId")));
  });
  router.delete("/connections/:connectionId", async (req, res) => {
    res.json(await requireProviders(deps).remove(sessionOf(res).ctx, idParam(req, "connectionId")));
  });

  router.get("/models", async (_req, res) => {
    res.json(await requireModels(deps).list(sessionOf(res).ctx));
  });
  router.put("/models", async (req, res) => {
    res.json(await requireModels(deps).save(sessionOf(res).ctx, req.body ?? {}));
  });
  router.get("/models/preview", async (req, res) => {
    const query = req.query as Record<string, unknown>;
    // Parsed by the service against PreviewInput; unknown stages or runtimes fail with VALIDATION.
    const input = {
      ...(typeof query.stage === "string" ? { stage: query.stage } : {}),
      ...(typeof query.runtime === "string" ? { runtime: query.runtime } : {}),
    } as PreviewInput;
    res.json(await requireModels(deps).preview(sessionOf(res).ctx, input));
  });
  router.delete("/models/:preferenceId", async (req, res) => {
    await requireModels(deps).remove(sessionOf(res).ctx, idParam(req, "preferenceId"));
    res.status(204).end();
  });
  return router;
}
