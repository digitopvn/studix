import type { PlatformCredentialService } from "@studix/auth";
import { StudixError } from "@studix/shared";
import { Router } from "express";
import type { AppDeps } from "../app-deps.ts";
import { sessionOf } from "./api-context.ts";

function requirePlatform(deps: AppDeps): PlatformCredentialService {
  if (!deps.platformCredentials) {
    throw new StudixError("UNAVAILABLE", "Platform credentials are not enabled on this server", {
      retryable: false,
    });
  }
  return deps.platformCredentials;
}

/**
 * Platform infrastructure credentials (object storage and media vendor keys). Every route needs the
 * `platform:manage` permission, which only a signed-in operator holds; the service checks it, so an API key
 * or OAuth token never reaches a secret. Secrets are accepted in request bodies only; every response is
 * `no-store` and value-free.
 */
export function platformRoutes(deps: AppDeps): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/credentials", async (_req, res) => {
    res.json(await requirePlatform(deps).overview(sessionOf(res).ctx));
  });
  router.put("/credentials/storage", async (req, res) => {
    res.json(await requirePlatform(deps).saveStorageCredentials(sessionOf(res).ctx, req.body ?? {}));
  });
  router.post("/credentials/storage/test", async (_req, res) => {
    res.json(await requirePlatform(deps).testStorage(sessionOf(res).ctx));
  });
  router.put("/credentials/media/:name", async (req, res) => {
    const name = String(req.params.name);
    res.json(await requirePlatform(deps).saveMediaKey(sessionOf(res).ctx, name, req.body ?? {}));
  });
  router.post("/credentials/media/:name/test", async (req, res) => {
    res.json(await requirePlatform(deps).testMediaKey(sessionOf(res).ctx, String(req.params.name)));
  });
  router.post("/media/check", async (_req, res) => {
    res.json(await requirePlatform(deps).checkMultix(sessionOf(res).ctx));
  });
  router.delete("/credentials/:name", async (req, res) => {
    res.json(await requirePlatform(deps).revoke(sessionOf(res).ctx, String(req.params.name)));
  });
  return router;
}
