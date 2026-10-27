import type { TenantContext } from "../tenant.ts";

export interface PublishRequest {
  renderId: string;
  /** Tenant-relative storage key of the media to publish. */
  storageKey: string;
  title: string;
  description?: string;
  /** Approval that authorized this publish; adapters must refuse without one. */
  approvalId: string;
  idempotencyKey: string;
}

export interface PublishResult {
  platform: string;
  externalId: string;
  url?: string;
}

/** Delivers a render to an external destination. Publishing is always approval-gated. */
export interface PublisherAdapter {
  readonly id: string;
  readonly platform: string;
  publish(ctx: TenantContext, request: PublishRequest): Promise<PublishResult>;
}
