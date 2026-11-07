import { StudixError } from "@studix/shared";
import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../app-deps.ts";
import type { PlatformSettingsService } from "../platform-settings.ts";
import { parseBody, sessionOf } from "./api-context.ts";

const KeyName = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/, "must be an environment variable name");
const SetKeyBody = z.object({ value: z.string().min(1).max(600) }).strict();
const StorageKeyBody = z
  .object({ accessKeyId: z.string().min(1).max(600), secretAccessKey: z.string().min(1).max(600) })
  .strict();

function requirePlatform(deps: AppDeps): PlatformSettingsService {
  if (!deps.platform) {
    throw new StudixError("UNAVAILABLE", "Platform settings are not enabled on this server", {
      retryable: false,
    });
  }
  return deps.platform;
}

function keyName(raw: unknown): string {
  return parseBody(z.object({ name: KeyName }).strict(), { name: raw }, "key name").name;
}

/**
 * Storage & media settings for platform operators. Every route is limited to an operator's own dashboard
 * session (the service checks it), responses are `no-store`, and key values are accepted in a request body
 * only: no response, log line or audit record carries one.
 */
export function platformRoutes(deps: AppDeps): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/storage-media", async (_req, res) => {
    res.json(await requirePlatform(deps).overview(sessionOf(res).ctx));
  });
  router.post("/storage/test", async (_req, res) => {
    res.json(await requirePlatform(deps).testStorage(sessionOf(res).ctx));
  });
  router.put("/storage/key", async (req, res) => {
    const pair = parseBody(StorageKeyBody, req.body, "storage key");
    res.json(await requirePlatform(deps).setStorageKey(sessionOf(res).ctx, pair));
  });
  router.delete("/storage/key", async (_req, res) => {
    await requirePlatform(deps).revokeStorageKey(sessionOf(res).ctx);
    res.status(204).end();
  });
  router.post("/media-keys/:name/test", async (req, res) => {
    res.json(await requirePlatform(deps).testMediaKey(sessionOf(res).ctx, keyName(req.params.name)));
  });
  router.post("/media/test", async (_req, res) => {
    res.json(await requirePlatform(deps).testMedia(sessionOf(res).ctx));
  });
  router.put("/media-keys/:name", async (req, res) => {
    const { value } = parseBody(SetKeyBody, req.body, "media key");
    res.json(await requirePlatform(deps).setMediaKey(sessionOf(res).ctx, keyName(req.params.name), value));
  });
  router.delete("/media-keys/:name", async (req, res) => {
    res.json(await requirePlatform(deps).revokeMediaKey(sessionOf(res).ctx, keyName(req.params.name)));
  });
  return router;
}
