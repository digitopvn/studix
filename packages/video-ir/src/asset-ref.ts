import { z } from "zod";
import { IrId } from "./primitives.ts";

export const AssetSource = z.enum(["upload", "generated", "stock", "rendered", "brand", "external"]);
export type AssetSource = z.infer<typeof AssetSource>;

/** Where an asset came from; required so every pixel in a render is attributable. */
export const AssetProvenance = z.object({
  source: AssetSource,
  /** Provider id (e.g. a media provider or MCP server) that produced or supplied the asset. */
  provider: z.string().min(1).max(120).optional(),
  model: z.string().min(1).max(200).optional(),
  /** Prompt used for generated assets; never contains secrets. */
  prompt: z.string().max(4000).optional(),
  license: z.string().max(200).optional(),
  /** Original location for external/stock assets. */
  sourceUrl: z.url().optional(),
  /** Asset version ids this asset was derived from. */
  derivedFrom: z.array(z.string().min(1)).max(32).optional(),
  createdAt: z.iso.datetime({ offset: true }).optional(),
});
export type AssetProvenance = z.infer<typeof AssetProvenance>;

/** `code`: a versioned declarative composition (HTML composition or GL scene module) used by composition shots. */
export const AssetMediaKind = z.enum(["image", "video", "audio", "font", "document", "code"]);
export type AssetMediaKind = z.infer<typeof AssetMediaKind>;

/**
 * Immutable reference to a stored binary. IR documents never embed binaries; they point at a storage
 * key (tenant-relative object key) or an absolute URI, pinned by content hash.
 */
export const AssetRef = z
  .object({
    id: IrId,
    kind: AssetMediaKind,
    /** Object key relative to the tenant prefix, e.g. `assets/ast_.../v1/logo.png`. */
    storageKey: z
      .string()
      .min(1)
      .max(512)
      .regex(/^(?!\/)(?!.*\.\.)[\w\-./]+$/, "relative key without '..' segments")
      .optional(),
    uri: z.url().optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/, "lowercase hex sha256"),
    mime: z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/, "expected a MIME type"),
    bytes: z.number().int().min(0).optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    durationMs: z.number().int().min(0).optional(),
    /** Platform asset version id, when the asset is tracked in the asset library. */
    assetVersionId: z.string().min(1).optional(),
    provenance: AssetProvenance,
  })
  .refine((ref) => ref.storageKey !== undefined || ref.uri !== undefined, {
    message: "an asset ref needs a storageKey or a uri",
    path: ["storageKey"],
  });
export type AssetRef = z.infer<typeof AssetRef>;
