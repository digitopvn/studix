import { StudixError } from "@studix/shared";
import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../app-deps.ts";
import { parseBody, sessionOf } from "./api-context.ts";

/** The workspace job webhook, the same as the `studix_webhook` MCP tool. */
export function webhookRoutes(deps: AppDeps): Router {
  const router = Router();
  const hooks = () => {
    if (!deps.webhooks) throw new StudixError("UNAVAILABLE", "Webhooks are not configured on this server");
    return deps.webhooks;
  };
  router.get("/", async (_req, res) => {
    res.json({ webhook: await hooks().get(sessionOf(res).ctx) });
  });
  router.put("/", async (req, res) => {
    const body = parseBody(z.object({ url: z.string().trim().min(1).max(2000) }), req.body, "webhook");
    res.json({ webhook: await hooks().set(sessionOf(res).ctx, body.url) });
  });
  router.delete("/", async (_req, res) => {
    res.json(await hooks().remove(sessionOf(res).ctx));
  });
  return router;
}
