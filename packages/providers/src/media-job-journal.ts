import type { MediaKind, ProviderJobRef, TenantContext } from "@studix/core";

/** submitted: paid and running upstream; completed: outputs collected; failed: ended without outputs. */
export type MediaJobState = "submitted" | "completed" | "failed";

/** What a provider must remember about an upstream job to collect it later instead of paying again. */
export interface MediaJobRecord {
  idempotencyKey: string;
  kind: MediaKind;
  model: string;
  job: ProviderJobRef;
  /** Submission attempt for this idempotency key; a failed job is resubmitted as the next attempt. */
  attempt: number;
  state: MediaJobState;
  estimatedCostCents: number;
  /** Charge reported when the job completed. */
  receiptCents?: number;
  submittedAt: string;
  updatedAt: string;
}

/**
 * Durable memory of upstream jobs, keyed by workspace and idempotency key. The record is written right
 * after submission, so a worker that dies while waiting leaves enough behind for the next attempt to
 * resume the same paid job. Implementations must scope reads and writes by `ctx.workspaceId`.
 */
export interface MediaJobJournal {
  get(ctx: TenantContext, idempotencyKey: string): Promise<MediaJobRecord | undefined>;
  put(ctx: TenantContext, record: MediaJobRecord): Promise<void>;
}

/**
 * Process-local journal. It survives retries inside one worker process only; production wiring stores the
 * record with the stage checkpoint so another worker can resume it.
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

  private key(ctx: TenantContext, idempotencyKey: string): string {
    return JSON.stringify([ctx.workspaceId, idempotencyKey]);
  }
}
