import { z } from "zod";
import { AssetListInput, AssetUpdateInput, listAssets, updateAsset } from "../asset-library.ts";
import type { NativeTool } from "./native-tools.ts";

export const ASSET_TOOL_NAMES = {
  list: "studix_list_assets",
  update: "studix_update_asset",
} as const;

function tool<I extends z.ZodType>(def: NativeTool<I>): NativeTool<I> {
  return def;
}

const UpdateInput = AssetUpdateInput.extend({ assetId: z.string().trim().min(1).max(100) });

/**
 * The asset library. Every asset has a `role` (what it is for) and a virtual folder `path` such as
 * `ep03/sc01/s05`; there is no folder table. Agents saving files should set both.
 */
export const ASSET_MCP_TOOLS = [
  tool({
    name: ASSET_TOOL_NAMES.list,
    title: "List assets",
    description:
      "List assets, newest first. Filter by role (sfx, bgm, voice, vfx, character, ...), folder path (with subfolders), tag, kind or projectId.",
    input: AssetListInput,
    readOnly: true,
    async run(ctx, input) {
      const data = await listAssets(ctx.deps.repos.assets, ctx.tenant, input);
      return {
        data,
        next: data.nextCursor
          ? [
              {
                tool: ASSET_TOOL_NAMES.list,
                arguments: { ...input, cursor: data.nextCursor },
                reason: "More assets match.",
              },
            ]
          : [],
      };
    },
  }),
  tool({
    name: ASSET_TOOL_NAMES.update,
    title: "Organize an asset",
    description:
      "Set an asset's role, folder path (ep03/sc01/s05; '' = root), tags (replaces all) or name. Files and versions stay.",
    input: UpdateInput,
    readOnly: false,
    idempotent: true,
    audited: true,
    async run(ctx, input) {
      const { assetId, ...patch } = input;
      const asset = await updateAsset(ctx.deps.repos.assets, ctx.tenant, assetId, patch);
      return {
        data: { asset },
        next: [
          {
            tool: ASSET_TOOL_NAMES.list,
            arguments: { path: asset.path, role: asset.role },
            reason: "See what else is in this folder.",
          },
        ],
        ...(asset.projectId ? { scope: { projectId: asset.projectId } } : {}),
      };
    },
  }),
];
