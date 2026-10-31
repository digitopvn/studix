import { createLogger, loadConfig, StudixError } from "@studix/shared";
import {
  computeBenchmark,
  formatBenchmarkMarkdown,
  loadBenchmarkRows,
} from "../src/benchmark/job-benchmark.ts";
import { createDb } from "../src/client.ts";

const USAGE = "pnpm --filter @studix/database benchmark [--json] <jobId> [jobId...]";

/** `pnpm --filter @studix/database benchmark`: production benchmark of the given jobs, read-only. */
async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const json = args.includes("--json");
  const jobIds = [...new Set(args.filter((a) => !a.startsWith("--")))];
  if (jobIds.length === 0) {
    throw new StudixError("VALIDATION", "at least one job id is required", { suggestedAction: USAGE });
  }
  const config = loadConfig();
  if (!config.DATABASE_URL) {
    throw new StudixError("VALIDATION", "DATABASE_URL is required", { suggestedAction: "Set it in .env" });
  }
  const handle = createDb(config.DATABASE_URL, { max: 1, applicationName: "studix-benchmark" });
  try {
    const report = computeBenchmark(await loadBenchmarkRows(handle.client, jobIds), jobIds);
    process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatBenchmarkMarkdown(report));
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  createLogger({ service: "db-benchmark" }).error("benchmark failed", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
});
