/**
 * Platform-operator recovery of an Atlas media call that a worker lost between its `submitting` intent and
 * the prediction id. The record stays `submitting` and blocks every retry of the job, because submitting
 * again could pay twice. Find the prediction in `multix history` or the Atlas console, check that it is the
 * one this request paid for (model and time), then:
 *
 *   DATABASE_URL=... pnpm --filter @studix/worker attach-media-job \
 *     --job job_xxx --stage motion --key <idempotency key of the record> --prediction <atlas prediction id>
 *
 * It needs database access and the platform Atlas account, so it is not an HTTP route: workspace admins
 * must not be able to point a job at a prediction of another tenant. The job must be `failed`; retry it
 * afterwards (dashboard or `studix_retry_job`) and the stage collects the prediction.
 */
import { parseArgs } from "node:util";
import { createDb, createRepositories } from "@studix/database";
import { StudixError, systemClock } from "@studix/shared";

const { values } = parseArgs({
  options: {
    job: { type: "string" },
    stage: { type: "string" },
    key: { type: "string" },
    prediction: { type: "string" },
    operator: { type: "string" },
  },
});
const url = process.env.DATABASE_URL;
if (!url || !values.job || !values.stage || !values.key || !values.prediction) {
  console.error(
    "usage: DATABASE_URL=... attach-media-job --job <id> --stage <name> --key <key> --prediction <id> [--operator <name>]",
  );
  process.exit(2);
}

const handle = createDb(url, { max: 2, applicationName: "studix-attach-media-job" });
try {
  const rows = await handle.client<{ id: string; organization_id: string; workspace_id: string }[]>`
    select id, organization_id, workspace_id from jobs where id = ${values.job}`;
  const row = rows[0];
  if (!row) throw new StudixError("NOT_FOUND", `job ${values.job} not found`);
  const { queue } = createRepositories(handle.db, { clock: systemClock });
  const operator = values.operator ?? process.env.USER ?? "operator";
  const recovered = await queue.attachMediaJob(
    {
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      actor: { type: "system", id: `operator:${operator}` },
    },
    row.id,
    {
      stage: values.stage,
      idempotencyKey: values.key,
      predictionId: values.prediction,
      actor: { type: "system", id: `operator:${operator}` },
    },
  );
  console.log(
    JSON.stringify({ jobId: row.id, state: recovered.state, job: recovered.job, next: "retry the job" }),
  );
} catch (err) {
  console.error(err instanceof StudixError ? `${err.code}: ${err.message}` : String(err));
  process.exitCode = 1;
} finally {
  await handle.close();
}
