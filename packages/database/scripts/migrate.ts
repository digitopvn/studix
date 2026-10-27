import { createLogger, loadConfig, StudixError } from "@studix/shared";
import { migrate } from "../src/migrate.ts";

/** `pnpm db:migrate`: apply pending migrations to DATABASE_URL. */
async function main(): Promise<void> {
  const log = createLogger({ service: "db-migrate" });
  const config = loadConfig();
  if (!config.DATABASE_URL) {
    throw new StudixError("VALIDATION", "DATABASE_URL is required", { suggestedAction: "Set it in .env" });
  }
  await migrate(config.DATABASE_URL);
  log.info("migrations applied");
}

main().catch((err: unknown) => {
  createLogger({ service: "db-migrate" }).error("migration failed", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
});
