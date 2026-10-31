import type postgres from "postgres";

/**
 * Production benchmark over a fixed list of jobs, computed only from what the engine already records:
 * jobs, stage attempts, the usage ledger, provider executions, approvals, project versions, storyboards,
 * renders and the stage cache. Nothing is estimated; a metric whose inputs are missing is `null`.
 */

export interface BenchmarkJobRow {
  id: string;
  workspaceId: string;
  projectId: string | null;
  workflowTemplate: string | null;
  kind: string;
  status: string;
  attempts: number;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface BenchmarkStageRow {
  jobId: string;
  name: string;
  attempt: number;
  status: string;
  /** `stages.error`; QA failures carry `details.failures`. */
  error: Record<string, unknown> | null;
  /** The output was served from the stage cache of another job. */
  fromCache: boolean;
}

export interface BenchmarkUsageRow {
  jobId: string;
  kind: string;
  costCents: number;
}

export interface BenchmarkProviderExecutionRow {
  jobId: string;
  provider: string;
  operation: string;
  status: string;
  costCents: number;
}

export interface BenchmarkApprovalRow {
  jobId: string;
  action: string;
  scopeKey: string;
  status: string;
  decidedByType: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

export interface BenchmarkRenderRow {
  jobId: string;
  status: string;
  preset: string;
  /** `renders.probe.durationMs` of a stored render. */
  durationMs: number | null;
  createdAt: Date;
  completedAt: Date | null;
}

/** One asset the job's rendered IR points at; `reused` when its content existed before the job. */
export interface BenchmarkAssetRow {
  jobId: string;
  sha256: string;
  reused: boolean;
}

export interface BenchmarkProjectRow {
  projectId: string;
  /** Project versions made from reviewer feedback (`source = 'patch'`). */
  patchVersions: number;
  /** Storyboard revisions a person approved or sent back (each a dashboard review). */
  storyboardDecisions: number;
  /** Storyboard revisions sent back with `changes_requested`. */
  storyboardChangeRequests: number;
}

export interface BenchmarkRows {
  jobs: BenchmarkJobRow[];
  stages: BenchmarkStageRow[];
  usage: BenchmarkUsageRow[];
  providerExecutions: BenchmarkProviderExecutionRow[];
  approvals: BenchmarkApprovalRow[];
  renders: BenchmarkRenderRow[];
  assets: BenchmarkAssetRow[];
  projects: BenchmarkProjectRow[];
}

export interface QaFailure {
  stage: string;
  attempt: number;
  messages: string[];
}

export interface JobBenchmark {
  jobId: string;
  pack: string | null;
  status: string;
  /** Job created to the first stored render; includes time spent waiting at gates. */
  timeToPreviewMs: number | null;
  /** `timeToPreviewMs` minus the time approvals of the job waited for a decision before that render. */
  timeToPreviewExcludingGatesMs: number | null;
  videoSeconds: number;
  costCents: number;
  costByKind: Record<string, number>;
  agentCostCents: number;
  costPerVideoMinuteCents: number | null;
  agentCostPerVideoSecondCents: number | null;
  stageAttempts: number;
  failedStageAttempts: number;
  cachedStages: number;
  providerExecutions: number;
  failedProviderExecutions: number;
  assetsReferenced: number;
  assetsReused: number;
  qaRuns: number;
  qaPassed: number;
  qaFailures: QaFailure[];
  /** Approvals raised for the job: each is a point where a person had to act. */
  interventions: number;
  interventionsByAction: Record<string, number>;
  /** Approvals a person turned down (rejected or sent back with changes). */
  gateRejections: number;
}

export interface BenchmarkSummary {
  jobs: number;
  /** Terminal jobs that were not cancelled. */
  finishedJobs: number;
  succeededJobs: number;
  /** Jobs still queued, running or parked at a gate when measured. */
  unfinishedJobs: number;
  successRate: number | null;
  timeToPreviewP50Ms: number | null;
  timeToPreviewP95Ms: number | null;
  timeToPreviewExcludingGatesP50Ms: number | null;
  videoSeconds: number;
  costCents: number;
  costByKind: Record<string, number>;
  costPerVideoMinuteCents: number | null;
  agentCostCents: number;
  agentCostPerVideoSecondCents: number | null;
  /** Patch versions and storyboard change requests per distinct project, plus gate rejections. */
  revisionRounds: number;
  assetsReferenced: number;
  assetsReused: number;
  assetReuseRate: number | null;
  stageAttempts: number;
  cachedStages: number;
  qaRuns: number;
  qaPassed: number;
  qaFailures: number;
  /** Job approvals plus storyboard reviews of the measured projects (`storyboard.review`). */
  interventions: number;
  interventionsByAction: Record<string, number>;
}

export interface BenchmarkReport {
  jobs: JobBenchmark[];
  summary: BenchmarkSummary;
  /** Requested ids the database does not hold. */
  missingJobIds: string[];
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const AGENT_KIND = "agent.run";
/** Decided approvals that did not let the work through as it was. */
const TURNED_DOWN = new Set(["rejected", "changes_requested"]);

/** QA hard-gate stages: `<pack>.qa` in packs, `<prefix>_check` from `createQaStages`. */
export function isQaStage(name: string): boolean {
  return name.endsWith(".qa") || name === "qa_check" || name.endsWith(".qa_check");
}

function sumBy<T>(rows: readonly T[], value: (row: T) => number): number {
  return rows.reduce((total, row) => total + value(row), 0);
}

function addTo(target: Record<string, number>, key: string, amount: number): void {
  target[key] = (target[key] ?? 0) + amount;
}

/** Nearest-rank percentile; null for an empty sample. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

function qaMessages(error: Record<string, unknown> | null): string[] {
  const details = error?.details as { failures?: Array<{ message?: unknown }> } | undefined;
  const failures = details?.failures?.map((f) => String(f.message ?? "")).filter(Boolean) ?? [];
  if (failures.length > 0) return failures;
  return typeof error?.message === "string" ? [error.message] : [];
}

function benchmarkJob(job: BenchmarkJobRow, rows: BenchmarkRows): JobBenchmark {
  const mine = <T extends { jobId: string }>(list: readonly T[]) => list.filter((r) => r.jobId === job.id);
  const stages = mine(rows.stages);
  const usage = mine(rows.usage);
  const executions = mine(rows.providerExecutions);
  const approvals = mine(rows.approvals);
  const renders = mine(rows.renders).filter((r) => r.status === "succeeded");
  const assets = mine(rows.assets);

  const firstPreview = renders
    .map((r) => (r.completedAt ?? r.createdAt).getTime())
    .reduce<number | null>((min, at) => (min === null || at < min ? at : min), null);
  const timeToPreviewMs = firstPreview === null ? null : firstPreview - job.createdAt.getTime();
  const gateWaitMs =
    firstPreview === null
      ? 0
      : sumBy(approvals, (a) => {
          const end = Math.min(a.decidedAt?.getTime() ?? firstPreview, firstPreview);
          return Math.max(0, end - a.createdAt.getTime());
        });

  const costByKind: Record<string, number> = {};
  for (const u of usage) addTo(costByKind, u.kind, u.costCents);
  const costCents = sumBy(usage, (u) => u.costCents);
  const agentCostCents = costByKind[AGENT_KIND] ?? 0;
  const videoSeconds = sumBy(renders, (r) => (r.durationMs ?? 0) / 1000);

  const qaRows = stages.filter((s) => isQaStage(s.name) && !s.fromCache);
  const qaFailures = qaRows
    .filter((s) => s.status === "failed")
    .map((s) => ({ stage: s.name, attempt: s.attempt, messages: qaMessages(s.error) }));

  const interventionsByAction: Record<string, number> = {};
  for (const a of approvals) addTo(interventionsByAction, a.action, 1);

  return {
    jobId: job.id,
    pack: job.workflowTemplate,
    status: job.status,
    timeToPreviewMs,
    timeToPreviewExcludingGatesMs: timeToPreviewMs === null ? null : timeToPreviewMs - gateWaitMs,
    videoSeconds,
    costCents,
    costByKind,
    agentCostCents,
    costPerVideoMinuteCents: videoSeconds > 0 ? costCents / (videoSeconds / 60) : null,
    agentCostPerVideoSecondCents: videoSeconds > 0 ? agentCostCents / videoSeconds : null,
    stageAttempts: stages.length,
    failedStageAttempts: stages.filter((s) => s.status === "failed").length,
    cachedStages: stages.filter((s) => s.fromCache).length,
    providerExecutions: executions.length,
    failedProviderExecutions: executions.filter((e) => e.status !== "succeeded").length,
    assetsReferenced: assets.length,
    assetsReused: assets.filter((a) => a.reused).length,
    qaRuns: qaRows.filter((s) => s.status === "succeeded" || s.status === "failed").length,
    qaPassed: qaRows.filter((s) => s.status === "succeeded").length,
    qaFailures,
    interventions: approvals.length,
    interventionsByAction,
    gateRejections: approvals.filter((a) => TURNED_DOWN.has(a.status)).length,
  };
}

/** Pure computation over loaded rows; `requestedJobIds` keeps the report in the requested order. */
export function computeBenchmark(rows: BenchmarkRows, requestedJobIds: readonly string[]): BenchmarkReport {
  const byId = new Map(rows.jobs.map((j) => [j.id, j]));
  const found = requestedJobIds.filter((id) => byId.has(id));
  const jobs = found.map((id) => benchmarkJob(byId.get(id)!, rows));
  const jobRows = found.map((id) => byId.get(id)!);

  const finished = jobRows.filter((j) => TERMINAL.has(j.status) && j.status !== "cancelled");
  const succeeded = finished.filter((j) => j.status === "succeeded");
  const previews = jobs.flatMap((j) => (j.timeToPreviewMs === null ? [] : [j.timeToPreviewMs]));
  const previewsNoGates = jobs.flatMap((j) =>
    j.timeToPreviewExcludingGatesMs === null ? [] : [j.timeToPreviewExcludingGatesMs],
  );
  const videoSeconds = sumBy(jobs, (j) => j.videoSeconds);
  const costCents = sumBy(jobs, (j) => j.costCents);
  const agentCostCents = sumBy(jobs, (j) => j.agentCostCents);
  const costByKind: Record<string, number> = {};
  const interventionsByAction: Record<string, number> = {};
  for (const j of jobs) {
    for (const [kind, cents] of Object.entries(j.costByKind)) addTo(costByKind, kind, cents);
    for (const [action, n] of Object.entries(j.interventionsByAction))
      addTo(interventionsByAction, action, n);
  }
  const projectIds = new Set(jobRows.flatMap((j) => (j.projectId ? [j.projectId] : [])));
  const projects = rows.projects.filter((p) => projectIds.has(p.projectId));
  const projectRounds = sumBy(projects, (p) => p.patchVersions + p.storyboardChangeRequests);
  const storyboardReviews = sumBy(projects, (p) => p.storyboardDecisions);
  if (storyboardReviews > 0) addTo(interventionsByAction, "storyboard.review", storyboardReviews);
  const assetsReferenced = sumBy(jobs, (j) => j.assetsReferenced);
  const assetsReused = sumBy(jobs, (j) => j.assetsReused);

  return {
    jobs,
    missingJobIds: requestedJobIds.filter((id) => !byId.has(id)),
    summary: {
      jobs: jobs.length,
      finishedJobs: finished.length,
      succeededJobs: succeeded.length,
      unfinishedJobs: jobRows.filter((j) => !TERMINAL.has(j.status)).length,
      successRate: finished.length > 0 ? succeeded.length / finished.length : null,
      timeToPreviewP50Ms: percentile(previews, 50),
      timeToPreviewP95Ms: percentile(previews, 95),
      timeToPreviewExcludingGatesP50Ms: percentile(previewsNoGates, 50),
      videoSeconds,
      costCents,
      costByKind,
      costPerVideoMinuteCents: videoSeconds > 0 ? costCents / (videoSeconds / 60) : null,
      agentCostCents,
      agentCostPerVideoSecondCents: videoSeconds > 0 ? agentCostCents / videoSeconds : null,
      revisionRounds: projectRounds + sumBy(jobs, (j) => j.gateRejections),
      assetsReferenced,
      assetsReused,
      assetReuseRate: assetsReferenced > 0 ? assetsReused / assetsReferenced : null,
      stageAttempts: sumBy(jobs, (j) => j.stageAttempts),
      cachedStages: sumBy(jobs, (j) => j.cachedStages),
      qaRuns: sumBy(jobs, (j) => j.qaRuns),
      qaPassed: sumBy(jobs, (j) => j.qaPassed),
      qaFailures: sumBy(jobs, (j) => j.qaFailures.length),
      interventions: sumBy(jobs, (j) => j.interventions) + storyboardReviews,
      interventionsByAction,
    },
  };
}

/**
 * Read every row the benchmark needs for `jobIds` with read-only queries. Rows are matched by job and
 * workspace, so a job id never pulls data of another tenant.
 */
export async function loadBenchmarkRows(
  sql: postgres.Sql,
  jobIds: readonly string[],
): Promise<BenchmarkRows> {
  const ids = [...jobIds];
  const jobs = await sql<BenchmarkJobRow[]>`
    select j.id, j.workspace_id as "workspaceId", j.project_id as "projectId",
           p.workflow_template as "workflowTemplate", j.kind, j.status, j.attempts,
           j.created_at as "createdAt", j.finished_at as "finishedAt"
    from jobs j left join video_projects p on p.id = j.project_id and p.workspace_id = j.workspace_id
    where j.id in ${sql(ids)}`;
  if (jobs.length === 0) {
    return {
      jobs: [],
      stages: [],
      usage: [],
      providerExecutions: [],
      approvals: [],
      renders: [],
      assets: [],
      projects: [],
    };
  }
  const found = jobs.map((j) => j.id);
  const projectIds = [...new Set(jobs.flatMap((j) => (j.projectId ? [j.projectId] : [])))];

  const stages = await sql<BenchmarkStageRow[]>`
    select s.job_id as "jobId", s.name, s.attempt, s.status, s.error,
           exists (
             select 1 from stage_cache c
             where c.workspace_id = s.workspace_id and c.organization_id = s.organization_id
               and c.stage = s.name and c.output = s.output
               and c.job_id is distinct from s.job_id
           ) as "fromCache"
    from stages s join jobs j on j.id = s.job_id and j.workspace_id = s.workspace_id
    where s.job_id in ${sql(found)}`;
  const usage = await sql<BenchmarkUsageRow[]>`
    select u.job_id as "jobId", u.kind, u.cost_cents::float8 as "costCents"
    from usage_events u join jobs j on j.id = u.job_id and j.workspace_id = u.workspace_id
    where u.job_id in ${sql(found)}`;
  const providerExecutions = await sql<BenchmarkProviderExecutionRow[]>`
    select e.job_id as "jobId", e.provider, e.operation, e.status, e.cost_cents::float8 as "costCents"
    from provider_executions e join jobs j on j.id = e.job_id and j.workspace_id = e.workspace_id
    where e.job_id in ${sql(found)}`;
  const approvals = await sql<BenchmarkApprovalRow[]>`
    select a.subject_id as "jobId", a.action, a.scope_key as "scopeKey", a.status,
           a.decided_by_type as "decidedByType", a.created_at as "createdAt", a.decided_at as "decidedAt"
    from approvals a join jobs j on j.id = a.subject_id and j.workspace_id = a.workspace_id
    where a.subject_type = 'job' and a.subject_id in ${sql(found)}`;
  const renders = await sql<BenchmarkRenderRow[]>`
    select r.job_id as "jobId", r.status, r.preset,
           (r.probe->>'durationMs')::float8 as "durationMs",
           r.created_at as "createdAt", r.completed_at as "completedAt"
    from renders r join jobs j on j.id = r.job_id and j.workspace_id = r.workspace_id
    where r.job_id in ${sql(found)}`;
  // An asset is reused when content with its hash existed before the job: in the asset library or in the
  // IR of any project version of the workspace created before the job.
  const assets = await sql<BenchmarkAssetRow[]>`
    with job_assets as (
      select distinct j.id as job_id, j.workspace_id, j.created_at, a->>'sha256' as sha256
      from jobs j
      join renders r on r.job_id = j.id and r.workspace_id = j.workspace_id and r.status = 'succeeded'
      join project_versions v on v.id = r.version_id
      cross join lateral jsonb_array_elements(v.ir->'assets') a
      where j.id in ${sql(found)}
    )
    select ja.job_id as "jobId", ja.sha256,
           (exists (
              select 1 from asset_versions av
              where av.workspace_id = ja.workspace_id and av.sha256 = ja.sha256 and av.created_at < ja.created_at
            ) or exists (
              select 1 from project_versions pv
              where pv.workspace_id = ja.workspace_id and pv.created_at < ja.created_at
                and pv.ir->'assets' @> jsonb_build_array(jsonb_build_object('sha256', ja.sha256))
            )) as reused
    from job_assets ja`;
  const projects =
    projectIds.length === 0
      ? []
      : await sql<BenchmarkProjectRow[]>`
          select p.id as "projectId",
                 (select count(*)::int from project_versions v
                   where v.project_id = p.id and v.source = 'patch') as "patchVersions",
                 (select count(*)::int from project_storyboards s
                   where s.project_id = p.id
                     and s.storyboard->'approval'->>'status' in ('approved', 'changes_requested'))
                   as "storyboardDecisions",
                 (select count(*)::int from project_storyboards s
                   where s.project_id = p.id
                     and s.storyboard->'approval'->>'status' = 'changes_requested')
                   as "storyboardChangeRequests"
          from video_projects p where p.id in ${sql(projectIds)}`;

  return {
    jobs: jobs.map((j) => ({ ...j, createdAt: toDate(j.createdAt), finishedAt: toDateOrNull(j.finishedAt) })),
    stages: [...stages],
    usage: [...usage],
    providerExecutions: [...providerExecutions],
    approvals: approvals.map((a) => ({
      ...a,
      createdAt: toDate(a.createdAt),
      decidedAt: toDateOrNull(a.decidedAt),
    })),
    renders: renders.map((r) => ({
      ...r,
      createdAt: toDate(r.createdAt),
      completedAt: toDateOrNull(r.completedAt),
    })),
    assets: [...assets],
    projects: [...projects],
  };
}

// A client shared with drizzle returns timestamps as strings (drizzle replaces the postgres.js parsers).
const toDate = (value: Date | string) => (value instanceof Date ? value : new Date(value));
const toDateOrNull = (value: Date | string | null) => (value === null ? null : toDate(value));

const cents = (value: number | null) => (value === null ? "n/a" : `${value.toFixed(4)} ¢`);
const seconds = (ms: number | null) => (ms === null ? "n/a" : `${(ms / 1000).toFixed(1)} s`);
const ratio = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
const counts = (record: Record<string, number>) =>
  Object.entries(record)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}: ${Number.isInteger(value) ? value : value.toFixed(4)}`)
    .join(", ") || "none";

/** Markdown tables of the report, ready to paste into docs/METRICS.md. */
export function formatBenchmarkMarkdown(report: BenchmarkReport): string {
  const s = report.summary;
  const lines = [
    "| Metric | Value |",
    "| --- | --- |",
    `| Jobs (finished / succeeded / unfinished) | ${s.jobs} (${s.finishedJobs} / ${s.succeededJobs} / ${s.unfinishedJobs}) |`,
    `| Success rate | ${ratio(s.successRate)} |`,
    `| Time to preview p50 / p95 | ${seconds(s.timeToPreviewP50Ms)} / ${seconds(s.timeToPreviewP95Ms)} |`,
    `| Time to preview p50 without gate waits | ${seconds(s.timeToPreviewExcludingGatesP50Ms)} |`,
    `| Video rendered | ${s.videoSeconds.toFixed(1)} s |`,
    `| Cost (COGS) | ${cents(s.costCents)} (${counts(s.costByKind)}) |`,
    `| Cost per video minute | ${cents(s.costPerVideoMinuteCents)} |`,
    `| Agent cost per video second | ${cents(s.agentCostPerVideoSecondCents)} |`,
    `| Revision rounds | ${s.revisionRounds} |`,
    `| Assets reused | ${s.assetsReused}/${s.assetsReferenced} (${ratio(s.assetReuseRate)}) |`,
    `| Stages served from cache | ${s.cachedStages}/${s.stageAttempts} |`,
    `| QA hard gate (passed / runs, failures) | ${s.qaPassed}/${s.qaRuns}, ${s.qaFailures} |`,
    `| Human intervention points | ${s.interventions} (${counts(s.interventionsByAction)}) |`,
    "",
    "| Job | Pack | Status | Preview | Video | Cost | Agent ¢/s | QA | Gates |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.jobs.map(
      (j) =>
        `| \`${j.jobId}\` | ${j.pack ?? "-"} | ${j.status} | ${seconds(j.timeToPreviewMs)} | ` +
        `${j.videoSeconds.toFixed(1)} s | ${cents(j.costCents)} | ${cents(j.agentCostPerVideoSecondCents)} | ` +
        `${j.qaPassed}/${j.qaRuns} | ${j.interventions} |`,
    ),
  ];
  const failures = report.jobs.flatMap((j) =>
    j.qaFailures.map((f) => `- \`${j.jobId}\` ${f.stage} (attempt ${f.attempt}): ${f.messages.join("; ")}`),
  );
  if (failures.length > 0) lines.push("", "QA failures:", "", ...failures);
  if (report.missingJobIds.length > 0)
    lines.push("", `Missing jobs: ${report.missingJobIds.map((id) => `\`${id}\``).join(", ")}`);
  return `${lines.join("\n")}\n`;
}
