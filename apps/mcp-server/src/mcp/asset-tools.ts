import { ASSET_KINDS, STUDIX_TOOLS } from "@studix/core";
import { StudixError } from "@studix/shared";
import { z } from "zod";
import type { NativeTool, ToolContext } from "./native-tools.ts";

/** Names of the project asset tools. The list tool keeps the name core has always used. */
export const ASSET_TOOL_NAMES = {
  list: STUDIX_TOOLS.listAssets,
  get: "studix_get_asset",
  upload: "studix_upload_asset",
  update: "studix_update_asset",
  delete: "studix_delete_asset",
  restore: "studix_restore_asset",
} as const;

const Id = z.string().trim().min(1).max(100);

function service(ctx: ToolContext) {
  const assets = ctx.deps.assets;
  if (!assets) {
    throw new StudixError("UNAVAILABLE", "Asset management is not enabled on this server", {
      retryable: false,
    });
  }
  return assets;
}

function tool<I extends z.ZodType>(def: NativeTool<I>): NativeTool<I> {
  return def;
}

const getNext = (assetId: string) => ({
  tool: ASSET_TOOL_NAMES.get,
  arguments: { assetId },
  reason: "Read versions, lineage and a signed download URL.",
});

/**
 * Project assets: everything an agent needs to organize files without sandbox workarounds. Same operations
 * as `/api/assets` and the dashboard; WebMCP serves these exact tools.
 */
export const ASSET_MCP_TOOLS = [
  tool({
    name: ASSET_TOOL_NAMES.list,
    title: "List assets",
    description: "List or search workspace assets, newest first. Trashed assets only with state deleted|all.",
    input: z.object({
      projectId: Id.optional(),
      kind: z.enum(ASSET_KINDS).optional(),
      q: z.string().trim().min(1).max(100).optional().describe("Part of the name."),
      state: z.enum(["active", "deleted", "all"]).optional(),
      limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
      cursor: z.string().trim().min(1).max(200).optional(),
    }),
    readOnly: true,
    async run(ctx, input) {
      const page = await service(ctx).list(ctx.tenant, input);
      const first = page.items[0];
      return {
        data: page,
        next: first ? [getNext(first.id)] : [],
        ...(input.projectId ? { scope: { projectId: input.projectId } } : {}),
      };
    },
  }),
  tool({
    name: ASSET_TOOL_NAMES.get,
    title: "Get asset",
    description: "One asset with all versions, lineage (made from / used to make) and a signed download URL.",
    input: z.object({
      assetId: Id,
      versionId: Id.optional().describe("Sign this version instead of the current one."),
    }),
    readOnly: true,
    async run(ctx, input) {
      const data = await service(ctx).get(ctx.tenant, input);
      return {
        data,
        next: [],
        ...(data.asset.projectId ? { scope: { projectId: data.asset.projectId } } : {}),
      };
    },
  }),
  tool({
    name: ASSET_TOOL_NAMES.upload,
    title: "Upload asset",
    description:
      "Store a file: base64 (max 1.5 MB) or url (public https, max 100 MB). New asset, or a new version when assetId is given.",
    input: z.object({
      name: z.string().trim().min(1).max(200).optional().describe("File name; defaults to the URL's."),
      base64: z.string().min(1).optional(),
      url: z.string().trim().min(1).max(2000).optional(),
      contentType: z.string().trim().max(120).optional().describe("Detected from the file name if omitted."),
      projectId: Id.optional(),
      kind: z.enum(ASSET_KINDS).optional().describe("Inferred from the media type if omitted."),
      assetId: Id.optional().describe("Add a version to this asset instead of creating one."),
      license: z.string().trim().min(1).max(200).optional(),
      derivedFrom: z.array(Id).max(32).optional().describe("Version ids this file was made from."),
    }),
    readOnly: false,
    openWorld: true,
    audited: true,
    async run(ctx, input) {
      const data = await service(ctx).upload(ctx.tenant, input, ctx.signal);
      return {
        data,
        next: [getNext(data.asset.id)],
        ...(data.asset.projectId ? { scope: { projectId: data.asset.projectId } } : {}),
      };
    },
  }),
  tool({
    name: ASSET_TOOL_NAMES.update,
    title: "Update asset",
    description: "Rename an asset and/or move it to another project (projectId null detaches it).",
    input: z.object({
      assetId: Id,
      name: z.string().trim().min(1).max(200).optional(),
      projectId: Id.nullable().optional(),
    }),
    readOnly: false,
    idempotent: true,
    audited: true,
    async run(ctx, input) {
      const asset = await service(ctx).update(ctx.tenant, input);
      return {
        data: { asset },
        next: [],
        ...(asset.projectId ? { scope: { projectId: asset.projectId } } : {}),
      };
    },
  }),
  tool({
    name: ASSET_TOOL_NAMES.delete,
    title: "Delete asset",
    description: "Move an asset to the trash. Files are kept, so studix_restore_asset undoes it.",
    input: z.object({ assetId: Id }),
    readOnly: false,
    idempotent: true,
    audited: true,
    async run(ctx, input) {
      const asset = await service(ctx).setDeleted(ctx.tenant, input.assetId, true);
      return {
        data: { asset },
        next: [
          {
            tool: ASSET_TOOL_NAMES.restore,
            arguments: { assetId: asset.id },
            reason: "Undo the deletion.",
          },
        ],
      };
    },
  }),
  tool({
    name: ASSET_TOOL_NAMES.restore,
    title: "Restore asset",
    description: "Bring a trashed asset back.",
    input: z.object({ assetId: Id }),
    readOnly: false,
    idempotent: true,
    audited: true,
    async run(ctx, input) {
      const asset = await service(ctx).setDeleted(ctx.tenant, input.assetId, false);
      return { data: { asset }, next: [getNext(asset.id)] };
    },
  }),
] as const;
