/**
 * Platform operator recovery of a job whose Atlas call is stuck in "submitting" (the job failed with
 * "may already have been charged"). Find the prediction in `multix history` or the Atlas Cloud console and
 * check that its model, inputs and time match the job's stage, then attach it and requeue the job:
 *
 *   pnpm --filter @studix/mcp-server recover:attach --job <jobId> --stage <stage> \
 *     --key <idempotencyKey> --prediction <predictionId> --operator <your-name> [--no-retry]
 *
 * Runs with the app's environment (DATABASE_URL), e.g. inside the app container. Prints ids and states only.
 */
import { parseArgs } from "node:util";
import { createDefaultApprovalPolicy, StudioService } from "@studix/core";
import { createDb, createRepositories } from "@studix/database";
import { loadConfig, StudixError, systemClock, toStudixError } from "@studix/shared";
import { attachMediaJobAsOperator } from "../src/operator/attach-media-job.ts";

async function main(): Promise<void> {
  // `pnpm run x -- --flag` passes the separator through; drop it so the flags still parse.
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    options: {
      job: { type: "string" },
      stage: { type: "string" },
      key: { type: "string" },
      prediction: { type: "string" },
      operator: { type: "string" },
      "no-retry": { type: "boolean", default: false },
    },
  });
  const { job, stage, key, prediction, operator } = values;
  if (!job || !stage || !key || !prediction || !operator) {
    throw new StudixError("VALIDATION", "--job, --stage, --key, --prediction and --operator are required");
  }
  const config = loadConfig(process.env);
  if (!config.DATABASE_URL) throw new StudixError("VALIDATION", "DATABASE_URL is required");
  const handle = createDb(config.DATABASE_URL, { max: 1, applicationName: "studix-operator" });
  try {
    const studio = new StudioService({
      ...createRepositories(handle.db, { clock: systemClock }),
      approvalPolicy: createDefaultApprovalPolicy({
        costThresholdCents: config.APPROVAL_COST_THRESHOLD_CENTS,
      }),
      clock: systemClock,
    });
    const result = await attachMediaJobAsOperator(
      { client: handle.client, studio },
      {
        jobId: job,
        stage,
        idempotencyKey: key,
        predictionId: prediction,
        operator,
        retry: !values["no-retry"],
      },
    );
    console.log(
      JSON.stringify({
        jobId: result.job.id,
        jobStatus: result.job.status,
        mediaJob: { state: result.mediaJob.state, attempt: result.mediaJob.attempt },
        ...(result.retryError ? { attached: true, retryError: result.retryError } : {}),
      }),
    );
    if (result.retryError) process.exitCode = 1;
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  const err = toStudixError(error);
  console.error(JSON.stringify({ code: err.code, error: err.message }));
  process.exit(1);
});
