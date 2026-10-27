import { createInMemoryUsageRepository } from "@studix/core/testing";
import { type Clock, systemClock } from "@studix/shared";
import { createUsageLedger } from "./repository-usage-ledger.ts";
import type { UsageLedger } from "./usage-ledger.ts";

/** In-memory ledger with the same idempotency semantics as Postgres (unit tests only). */
export function createInMemoryUsageLedger(clock: Clock = systemClock): UsageLedger {
  return createUsageLedger(createInMemoryUsageRepository(clock));
}
