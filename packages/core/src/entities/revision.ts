import type { TenantOwned } from "./common.ts";

export const IR_NODE_KINDS = ["scene", "shot"] as const;
export type IrNodeKind = (typeof IR_NODE_KINDS)[number];

/**
 * Immutable revision of one scene or shot of a project, next to the ProjectVersion that introduced it.
 * `digest` is the node's dependency digest (`nodeDigests(videoIrNodes(ir))`): a new revision exists only
 * when the node or something it depends on changed, so later versions reuse unchanged revisions.
 */
export interface NodeRevision extends TenantOwned {
  projectId: string;
  kind: IrNodeKind;
  /** Scene or shot id inside the IR. */
  nodeId: string;
  /** 1-based, increasing per (project, kind, nodeId). */
  revision: number;
  digest: string;
  /** The scene (without its shots) or shot JSON at this revision. */
  content: Record<string, unknown>;
  /** Project version that first produced this revision. */
  versionId: string;
}

/** Scene and shot revisions of one project version. */
export interface VersionRevisions {
  versionId: string;
  revisions: NodeRevision[];
  /**
   * Node keys (`scene:<id>`, `shot:<id>`) whose revision differs from the parent version's: the work to
   * redo. Every node is invalidated for a version without a parent.
   */
  invalidated: string[];
}

export const LINEAGE_INPUT_KINDS = ["asset_version", "node_revision"] as const;
export type LineageInputKind = (typeof LINEAGE_INPUT_KINDS)[number];

/** One input an asset version was generated from: another asset version or a scene/shot revision. */
export interface AssetLineage extends TenantOwned {
  /** The derived (output) asset version. */
  assetVersionId: string;
  inputKind: LineageInputKind;
  inputId: string;
  /** How the input was used, e.g. "start-frame", "reference", "prompt". */
  role?: string;
  jobId?: string;
}

/** Memoized output of a stage run, keyed by the stage's cacheKey within one tenant. */
export interface StageCacheEntry extends TenantOwned {
  stage: string;
  cacheKey: string;
  output: Record<string, unknown>;
  /** Job whose run produced the output (and paid for it). */
  jobId?: string;
}
