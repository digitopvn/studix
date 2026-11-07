import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../app-deps.ts";
import { AssetListInput, AssetUpdateInput, listAssets, updateAsset } from "../asset-library.ts";
import { idParam, parseBody, sessionOf } from "./api-context.ts";

const ListQuery = AssetListInput.extend({ limit: z.coerce.number().int().min(1).max(100).optional() });

/** The dashboard Assets page: list by role, folder, tag or kind, and change an asset's role, folder or tags. */
export function assetRoutes(deps: AppDeps): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/", async (req, res) => {
    const query = parseBody(ListQuery, req.query, "asset query");
    res.json(await listAssets(deps.repos.assets, sessionOf(res).ctx, query));
  });
  router.patch("/:assetId", async (req, res) => {
    const body = parseBody(AssetUpdateInput, req.body, "asset update");
    const { ctx } = sessionOf(res);
    const asset = await updateAsset(deps.repos.assets, ctx, idParam(req, "assetId"), body);
    await deps.activity?.record(ctx, {
      name: "api.asset.update",
      ...(asset.projectId ? { scope: { projectId: asset.projectId } } : {}),
      attributes: { assetId: asset.id, actorType: ctx.actor.type, actorId: ctx.actor.id },
    });
    res.json(asset);
  });
  return router;
}
