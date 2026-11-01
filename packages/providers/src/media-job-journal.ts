import {
  canClaimMediaJob,
  type MediaJobJournal,
  type MediaJobRecord,
  type TenantContext,
} from "@studix/core";

/** The journal contract lives in `@studix/core` so workflow stages can hand providers a durable one. */
export type { MediaJobJournal, MediaJobRecord, MediaJobState } from "@studix/core";

/**
 * Process-local journal, the provider's fallback when a request brings none. It survives retries inside one
 * worker process only; workflow stages pass their stage journal (`StageContext.mediaJournal`), which is
 * stored with the stage checkpoint so another worker can resume the job.
 */
export class InMemoryMediaJobJournal implements MediaJobJournal {
  private readonly records = new Map<string, MediaJobRecord>();

  async get(ctx: TenantContext, idempotencyKey: string): Promise<MediaJobRecord | undefined> {
    const record = this.records.get(this.key(ctx, idempotencyKey));
    return record ? structuredClone(record) : undefined;
  }

  async put(ctx: TenantContext, record: MediaJobRecord): Promise<void> {
    this.records.set(this.key(ctx, record.idempotencyKey), structuredClone(record));
  }

  async claim(ctx: TenantContext, record: MediaJobRecord): Promise<boolean> {
    const key = this.key(ctx, record.idempotencyKey);
    if (!canClaimMediaJob(this.records.get(key), record)) return false;
    this.records.set(key, structuredClone(record));
    return true;
  }

  private key(ctx: TenantContext, idempotencyKey: string): string {
    return JSON.stringify([ctx.workspaceId, idempotencyKey]);
  }
}
