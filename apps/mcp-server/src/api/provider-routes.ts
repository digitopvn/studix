import { StudixError } from "@studix/shared";
import { Router } from "express";
import type { AppDeps } from "../app-deps.ts";
import {
  CreateConnectionBody,
  type ProviderAdmin,
  RotateConnectionBody,
  TestConnectionBody,
  UpsertPreferenceBody,
} from "../provider-admin.ts";
import { idParam, parseBody, sessionOf } from "./api-context.ts";

function requireProviders(deps: AppDeps): ProviderAdmin {
  if (!deps.providers) {
    throw new StudixError("UNAVAILABLE", "Workspace AI providers are not enabled on this server", {
      retryable: false,
      suggestedAction: "Ask the operator to configure the credential keyring (STUDIX_CREDENTIAL_KEYS).",
    });
  }
  return deps.providers;
}

/** Settings > AI & Models: provider catalog, API-key connections, model preferences and a preview. */
export function providerRoutes(deps: AppDeps): Router {
  const router = Router();
  // Responses may carry key hints and test messages; keep them out of shared caches.
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.get("/catalog", (_req, res) => {
    res.json({ items: requireProviders(deps).catalog() });
  });

  router.get("/connections", async (_req, res) => {
    res.json({ items: await requireProviders(deps).listConnections(sessionOf(res).ctx) });
  });
  router.post("/connections", async (req, res) => {
    const body = parseBody(CreateConnectionBody, req.body, "provider connection");
    res.status(201).json(await requireProviders(deps).createConnection(sessionOf(res).ctx, body));
  });
  router.post("/connections/:connectionId/test", async (req, res) => {
    const body = parseBody(TestConnectionBody, req.body, "connection test");
    const id = idParam(req, "connectionId");
    res.json(await requireProviders(deps).testConnection(sessionOf(res).ctx, id, body));
  });
  router.post("/connections/:connectionId/rotate", async (req, res) => {
    const body = parseBody(RotateConnectionBody, req.body, "key rotation");
    const id = idParam(req, "connectionId");
    res.json(await requireProviders(deps).rotateConnection(sessionOf(res).ctx, id, body));
  });
  router.delete("/connections/:connectionId", async (req, res) => {
    await requireProviders(deps).deleteConnection(sessionOf(res).ctx, idParam(req, "connectionId"));
    res.status(204).end();
  });

  router.get("/preferences", async (_req, res) => {
    res.json({ items: await requireProviders(deps).listPreferences(sessionOf(res).ctx) });
  });
  router.put("/preferences", async (req, res) => {
    const body = parseBody(UpsertPreferenceBody, req.body, "model preference");
    res.json(await requireProviders(deps).upsertPreference(sessionOf(res).ctx, body));
  });
  router.delete("/preferences/:preferenceId", async (req, res) => {
    await requireProviders(deps).deletePreference(sessionOf(res).ctx, idParam(req, "preferenceId"));
    res.status(204).end();
  });

  router.get("/resolution", async (_req, res) => {
    res.json({ items: await requireProviders(deps).preview(sessionOf(res).ctx) });
  });
  return router;
}
