import { nodeDigests, nodeKey, type VideoIR, videoIrNodes } from "@studix/video-ir";
import type { NewRecord } from "../entities/common.ts";
import type {
  AssetLineage,
  IrNodeKind,
  LineageInputKind,
  NodeRevision,
  StageCacheEntry,
  VersionRevisions,
} from "../entities/revision.ts";
import type { TenantContext } from "../tenant.ts";

export type NewAssetLineage = NewRecord<AssetLineage>;

export interface LineageInput {
  kind: LineageInputKind;
  id: string;
}

export interface RevisionRepository {
  /**
   * Record the scene and shot revisions of a stored project version. A node whose digest already has a
   * revision in the project reuses it; otherwise the next revision number is created. Idempotent: calling
   * it again for the same version returns the recorded revisions. Throws NOT_FOUND for an unknown version.
   */
  recordVersion(ctx: TenantContext, versionId: string): Promise<VersionRevisions>;
  /** Revisions of a version recorded by recordVersion (empty when it was never recorded). */
  listVersionRevisions(ctx: TenantContext, versionId: string): Promise<NodeRevision[]>;
  getRevision(ctx: TenantContext, id: string): Promise<NodeRevision | undefined>;
  /** Record what an asset version was generated from; an input already recorded for it is ignored. */
  addLineage(ctx: TenantContext, inputs: NewAssetLineage[]): Promise<AssetLineage[]>;
  listLineage(ctx: TenantContext, assetVersionId: string): Promise<AssetLineage[]>;
  /**
   * Asset versions generated, directly or through other asset versions, from any of `inputs`: what goes
   * stale when those inputs are invalidated. Sorted, without duplicates.
   */
  derivedAssetVersions(ctx: TenantContext, inputs: LineageInput[]): Promise<string[]>;
}

export interface StageCacheRepository {
  get(ctx: TenantContext, stage: string, cacheKey: string): Promise<StageCacheEntry | undefined>;
  /** First write wins: when the key is already cached the stored entry is returned unchanged. */
  put(ctx: TenantContext, input: NewRecord<StageCacheEntry>): Promise<StageCacheEntry>;
}

/** A scene or shot of an IR with its dependency digest, before it is matched to a stored revision. */
export interface IrNodeSnapshot {
  kind: IrNodeKind;
  nodeId: string;
  digest: string;
  content: Record<string, unknown>;
}

/** Scenes (without their shots) and shots of an IR with their dependency digests, in document order. */
export function irNodeSnapshots(ir: VideoIR): IrNodeSnapshot[] {
  const digests = nodeDigests(videoIrNodes(ir));
  const out: IrNodeSnapshot[] = [];
  for (const scene of ir.scenes) {
    const { shots, ...own } = scene;
    out.push({
      kind: "scene",
      nodeId: scene.id,
      digest: digests.get(nodeKey.scene(scene.id)) as string,
      content: { ...own, shotIds: shots.map((s) => s.id) },
    });
    for (const shot of shots) {
      out.push({
        kind: "shot",
        nodeId: shot.id,
        digest: digests.get(nodeKey.shot(shot.id)) as string,
        content: shot,
      });
    }
  }
  return out;
}

export function revisionNodeKey(revision: Pick<NodeRevision, "kind" | "nodeId">): string {
  return `${revision.kind}:${revision.nodeId}`;
}

/** Node keys of `revisions` whose revision is not the one the parent version used. */
export function invalidatedSince(revisions: NodeRevision[], parent: NodeRevision[] | undefined): string[] {
  const before = new Set((parent ?? []).map((r) => r.id));
  return revisions.filter((r) => !before.has(r.id)).map(revisionNodeKey);
}
