import { StudixError } from "@studix/shared";
import { Router } from "express";
import type { AppDeps } from "../app-deps.ts";
import type { PlatformAdmin } from "../platform-admin.ts";
import { sessionOf } from "./api-context.ts";

/**
 * The operator gate. A workspace owner is not an operator: the list lives in STUDIX_OPERATOR_EMAILS and the
 * address must be provider-verified. Everyone else, including API keys and agents, gets the same FORBIDDEN
 * whether or not the feature exists, so the route does not reveal who the operators are.
 */
function requireOperator(deps: AppDeps, user: { email: string; emailVerified: boolean }): PlatformAdmin {
  if (!deps.platform?.isOperator(user)) {
    throw new StudixError("FORBIDDEN", "Only a platform operator can manage storage and media credentials", {
      retryable: false,
      suggestedAction:
        "Ask a platform operator, or add your verified sign-in email to STUDIX_OPERATOR_EMAILS.",
    });
  }
  return deps.platform;
}

/**
 * Platform storage and media credentials, session-authenticated and operator-only. Keys are accepted in a
 * request body only; no response ever contains a stored secret, and every response is `no-store`.
 */
export function platformRoutes(deps: AppDeps): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  const admin = (res: Parameters<typeof sessionOf>[0]) => requireOperator(deps, sessionOf(res).user);

  router.get("/media", async (_req, res) => {
    res.json(await admin(res).overview());
  });
  router.post("/media/storage/test", async (_req, res) => {
    res.json(await admin(res).testStorage());
  });
  router.post("/media/multix/check", async (_req, res) => {
    res.json(await admin(res).checkMultix());
  });
  router.put("/media/vendors/:vendor", async (req, res) => {
    const a = admin(res);
    res.json(await a.saveVendorKey(sessionOf(res).ctx, String(req.params.vendor), req.body ?? {}));
  });
  router.delete("/media/vendors/:vendor", async (req, res) => {
    const a = admin(res);
    res.json(await a.revokeVendorKey(sessionOf(res).ctx, String(req.params.vendor)));
  });
  router.post("/media/vendors/:vendor/test", async (req, res) => {
    const a = admin(res);
    res.json(await a.checkMultix(String(req.params.vendor)));
  });
  return router;
}
