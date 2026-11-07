import { assertPlatformOperator } from "@studix/core";
import { StudixError } from "@studix/shared";
import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../app-deps.ts";
import type { PlatformSettingsService } from "../platform-settings.ts";
import { parseBody, sessionOf } from "./api-context.ts";

/** The signed-in operator: a non-operator gets 403 before its request body is even read. */
function operatorOf(res: Parameters<typeof sessionOf>[0]) {
  const { ctx } = sessionOf(res);
  assertPlatformOperator(ctx);
  return ctx;
}

const KeyName = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/, "must be an environment variable name");
const SetKeyBody = z.object({ value: z.string().min(1).max(600) }).strict();
const StorageKeyBody = z
  .object({ accessKeyId: z.string().min(1).max(600), secretAccessKey: z.string().min(1).max(600) })
  .strict();

const ProfileFields = {
  name: z.string().min(1).max(80),
  providerType: z.enum(["cloudflare-r2", "aws-s3", "s3-compatible"]),
  endpoint: z.string().max(300).optional(),
  bucket: z.string().min(1).max(63),
  region: z.string().min(1).max(32),
  forcePathStyle: z.boolean().optional(),
  keyPrefix: z.string().max(128).optional(),
};
const Secret = z.string().min(1).max(600);
const CreateProfileBody = z
  .object({ ...ProfileFields, accessKeyId: Secret, secretAccessKey: Secret })
  .strict();
const UpdateProfileBody = z
  .object({ ...ProfileFields, accessKeyId: Secret.optional(), secretAccessKey: Secret.optional() })
  .strict()
  .refine((b) => (b.accessKeyId === undefined) === (b.secretAccessKey === undefined), {
    message: "accessKeyId and secretAccessKey are replaced together",
  });
const ProfileId = z.string().regex(/^(env|stp_[A-Za-z0-9]{6,40})$/, "must be a storage profile id");

function profileId(raw: unknown): string {
  return parseBody(z.object({ id: ProfileId }).strict(), { id: raw }, "storage profile id").id;
}

function splitProfile<T extends { accessKeyId?: string; secretAccessKey?: string }>(body: T) {
  const { accessKeyId, secretAccessKey, ...fields } = body;
  return {
    fields,
    key:
      accessKeyId !== undefined && secretAccessKey !== undefined
        ? { accessKeyId, secretAccessKey }
        : undefined,
  };
}

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
  router.get("/storage/profiles", async (_req, res) => {
    res.json(await requirePlatform(deps).listStorageProfiles(sessionOf(res).ctx));
  });
  router.post("/storage/profiles", async (req, res) => {
    const ctx = operatorOf(res);
    const { fields, key } = splitProfile(parseBody(CreateProfileBody, req.body, "storage profile"));
    res.status(201).json(await requirePlatform(deps).createStorageProfile(ctx, fields, key!));
  });
  router.put("/storage/profiles/:id", async (req, res) => {
    const ctx = operatorOf(res);
    const { fields, key } = splitProfile(parseBody(UpdateProfileBody, req.body, "storage profile"));
    res.json(await requirePlatform(deps).updateStorageProfile(ctx, profileId(req.params.id), fields, key));
  });
  router.post("/storage/profiles/:id/activate", async (req, res) => {
    res.json(await requirePlatform(deps).activateStorageProfile(operatorOf(res), profileId(req.params.id)));
  });
  router.post("/storage/profiles/:id/test", async (req, res) => {
    res.json(await requirePlatform(deps).testStorageProfile(operatorOf(res), profileId(req.params.id)));
  });
  router.delete("/storage/profiles/:id", async (req, res) => {
    await requirePlatform(deps).deleteStorageProfile(operatorOf(res), profileId(req.params.id));
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
