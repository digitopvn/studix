# Metrics

Baseline definitions for the P0 vertical slice. Every metric is computed from
traces and records Studix already writes (`packages/observability` spans,
`jobs`, `provider executions`, `usage events` in Postgres). No metric needs
extra client instrumentation.

A render that succeeds is **not** a video that was approved. Success metrics
below say which one they count.

## Definitions

### Pipeline

| Metric                   | Definition                                                           | How measured                                                                  |
| ------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Brief-to-preview latency | Time from `studix_create_video` accepted to a preview render stored  | `job.createdAt` to the preview render's stored timestamp; report p50/p95      |
| Job success rate         | Jobs reaching `succeeded` / jobs created, excluding cancelled        | Count by terminal state per window                                            |
| Approval rate            | Previews later approved / previews produced                          | Approval records joined to renders; separate from success rate                |
| Model calls per job      | Count of decision and agent model calls in one job                   | Provider execution spans per `jobId`                                          |
| Cost per job             | Sum of COGS for one job                                              | Sum of usage events per `jobId`; COGS only, not price                         |
| Retries per job          | Stage and provider retries in one job                                | Retry attempts recorded on spans                                              |
| User steps               | Client tool calls plus human dashboard actions from brief to preview | MCP calls per `jobId` + dashboard audit events; target is create + polls only |

### Decision routing (Jev)

| Metric                | Definition                                                      | How measured                                                   |
| --------------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| Decision latency      | Time for `DecisionRouter.decide` including retries and fallback | Decision span duration; p50/p95 per decision type and provider |
| Schema-valid rate     | Responses valid on first parse / responses received             | Validation outcome on decision spans, before retry             |
| Provider success rate | Successful decisions / attempts, per provider and model         | Attempt spans grouped by `providerId`, `modelId`               |
| Fallback rate         | Decisions served by a fallback adapter / decisions              | `fallbackReason` present on the result                         |
| Cost per decision     | COGS per decision, per provider and model                       | Usage on decision spans                                        |

### MCP-in-MCP gateway

| Metric                  | Definition                                                                         | How measured                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Tool search latency     | `studix_tool_search` server time                                                   | Span duration; p50/p95                                                                                                     |
| Tool inspect latency    | `studix_tool_inspect` server time                                                  | Span duration; p50/p95                                                                                                     |
| Tool execute latency    | `studix_tool_execute` server time, split into gateway overhead and downstream time | Gateway span minus downstream call span                                                                                    |
| Downstream success rate | Successful downstream calls / executes reaching downstream                         | Outcome on invocation traces per server                                                                                    |
| Deny rate               | Executes denied by policy / execute attempts                                       | Permission verdict on invocation traces                                                                                    |
| `tools/list` size       | Number of tools and serialized bytes of the northbound `tools/list` response       | Measured by the TS client test against a workspace with the mock connector registered; must not grow with downstream tools |

## Baseline results

Measured on the TOSE dev environment (Development server, then served at
`app.studix.digitop.ai`, now `dev-app.studix.digitop.ai`) at commit
`9f0fc42`, 2026-10-27, from six `studix_create_video` jobs (the demo prompt in
`apps/mcp-server/scripts/smoke-video.ts`, decision route
`video.brief=openrouter>rules`, model `openai/gpt-4o-mini`). Server times come
from `jobs.created_at` to `jobs.finished_at`; decision rows come from
`usage_events` of kind `provider.decision` (their `metadata` carries provider,
model, latency and tokens). Small sample: treat as a smoke baseline, not an SLO.
The worker now also writes one `provider_executions` row per decision attempt
(retries, fallbacks and failures included, operation `decision.<kind>`) and links
the winning attempt from the usage event's `provider_execution_id`; measurements
taken after that change should read latency, schema-valid and fallback rates from
`provider_executions` instead of `usage_events.metadata`.

| Metric                             | Value                                         | Sample                     | Evidence                                                                                            |
| ---------------------------------- | --------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| Brief-to-preview latency (p50/p95) | 17.6 s / 19.7 s server; 41-54 s at the client | 5 succeeded jobs           | `jobs` timestamps; client time from `pnpm smoke` includes sign-up                                   |
| Job success rate                   | 5/6 (83%)                                     | 6 jobs                     | The failure was the restart bug fixed in `f033ed0`; 5/5 after the fix                               |
| Approval rate                      | not applicable                                | 0 publish requests         | Staging demo does not publish                                                                       |
| Model calls per job                | 1                                             | 6 jobs                     | One `provider.decision` usage event per job                                                         |
| Cost per job                       | 0.0103 cents (model only)                     | 6 jobs, 0.0618 cents total | `usage_events.cost_cents`; render and storage are not priced yet                                    |
| Retries per job                    | 0                                             | 5 succeeded jobs           | `jobs.attempts = 1`, every stage `attempt = 1`                                                      |
| User steps                         | 1 create + polls                              | 6 jobs                     | `studix_create_video` then `studix_get_job` until `succeeded`                                       |
| Decision latency (p50/p95)         | 2.22 s / 2.77 s                               | 6 decisions                | `usage_events.metadata.latencyMs`                                                                   |
| Schema-valid rate                  | 6/6                                           | 6 decisions                | Every decision served first try, no retry recorded                                                  |
| Provider success rate              | 6/6 (openrouter, `openai/gpt-4o-mini`)        | 6 decisions                | `usage_events.metadata.provider`                                                                    |
| Fallback rate                      | 0/6                                           | 6 decisions                | No decision served by `rules`                                                                       |
| Cost per decision                  | 0.0103 cents (445 in / 62 out tokens)         | 6 decisions                | `usage_events`                                                                                      |
| Tool search latency (p50/p95)      | not measured on staging                       | none                       | Covered functionally by the gateway integration tests                                               |
| Tool inspect latency (p50/p95)     | not measured on staging                       | none                       | As above                                                                                            |
| Tool execute latency (p50/p95)     | not measured on staging                       | none                       | As above                                                                                            |
| Downstream success rate            | not measured on staging                       | none                       | As above                                                                                            |
| Deny rate                          | not measured on staging                       | none                       | As above                                                                                            |
| `tools/list` size (tools / bytes)  | 9 tools                                       | every smoke run            | `pnpm smoke` output; the gateway integration test asserts downstream tools stay out of `tools/list` |

Output per job: a 6 s, 1080x1920 MP4 of 143,372 bytes, rendered in about 13 s
of wall time by one worker with 4 GiB memory (HyperFrames low-memory profile,
software GPU).

## Vertical benchmark (epic #2)

Production benchmark of the two verticals on the shared engine: marketing
(`marketing-video` ads and a `motion-graphic` video, demo of issue #45) and
anime (`anime` scene, demo of issue #47). Numbers come only from
[`benchmark-jobs.ts`](../packages/database/scripts/benchmark-jobs.ts) run
against the database that ran the demo jobs; nothing here is estimated.

```bash
pnpm --filter @studix/database benchmark -- <jobId> [jobId...]
```

`--json` prints the full report (per-job rows, cost by usage kind, QA failure
messages) instead of the Markdown tables. The script only reads; it needs
`DATABASE_URL`. Definitions live next to the code in
[`job-benchmark.ts`](../packages/database/src/benchmark/job-benchmark.ts) and are
covered by [the fixture test](../packages/database/test/job-benchmark.test.ts)
and [the Postgres test](../packages/database/test/job-benchmark.integration.test.ts):

| Metric                      | Computed from                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Time to preview             | `jobs.created_at` to the first succeeded `renders` row of the job (`completed_at`); also reported minus the time the job's approvals waited for a decision                     |
| Success rate                | `succeeded` / terminal jobs that were not cancelled; jobs still running or parked at a gate are listed as unfinished                                                           |
| Cost per video minute       | Sum of `usage_events.cost_cents` of the job (every kind, COGS) / seconds of its succeeded renders (`renders.probe.durationMs`) x 60                                            |
| Agent cost per video second | `usage_events` of kind `agent.run` / the same seconds; host-agent runs are recorded at 0 cents                                                                                 |
| Revision rounds             | Per measured project: versions with `source = 'patch'` plus storyboard revisions sent back (`changes_requested`); plus job approvals turned down                               |
| Asset reuse                 | Assets in the IR of the job's rendered versions whose `sha256` already existed before the job (asset library or an earlier project version of the workspace) / all such assets |
| Stages served from cache    | Stage rows whose output equals a `stage_cache` entry written by another job                                                                                                    |
| Quality failures            | Runs of the QA hard-gate stages (`<pack>.qa`, `qa_check`) that failed, with the failure messages from `stages.error.details.failures`                                          |
| Human intervention points   | `approvals` with the job as subject (creative gates, overruns, spend) plus storyboard reviews (approved or sent back) of the measured projects                                 |

### Results

Measured on 2026-10-31 with the script above. Each demo was read from the database it ran on. Each table column covers every job of that vertical's pack in that database, including jobs that were abandoned, failed or cancelled:

- Marketing (#45), 13 jobs:
  - ads (`marketing-video`): `job_01m68hqvak2k7aymfx0yw2qvvr`, `job_01m68jwhdrjg9ar6ahgs2bqqhk`, `job_01m68rxyhvs4ye1dks0ybqmjha`, `job_01m68s3xef1xzfdwbk6x81t5ep`, `job_01m68sf5s86rc25gr3qbcfq5t4`, `job_01m68vy631q0zmm9kjgymetakh`, `job_01m68w6q9sxrrdjn5m3z59de7a`, `job_01m6900f95qtxgnk1w31vzx4e6`, `job_01m691s38vp625bjydfktmbjsy` (final);
  - motion graphic (`motion-graphic`): `job_01m68wbz8hra438as3c7gk54md`, `job_01m68wj6rk3nc71xq0x4rd293d`, `job_01m6904xb3hzn0ph16cdk9bxg4`, `job_01m692dy72xb1g3ghbszfc0f6a` (final).
- Anime (#47), 9 jobs: `job_01m68m7eb72r6kmtg66pkaabgd`, `job_01m68r5755vqw0e7c6f50gc7pa`, `job_01m68rjrs21gbwne03znjh9mem`, `job_01m68y2rp8qkkzmmz9tngzzj0m`, `job_01m68yce26z30vgfn4bc9eq0fs`, `job_01m68yrp94waeh7vx6j89xkaee`, `job_01m690k786r8mj6z24jgns21q7`, `job_01m690kevxspsrxwywanpaswzm` (part B), `job_01m696g9607vnsqnt1cg8cfwga` (final re-render).

| Metric                      | Marketing (#45)                                                                                            | Anime (#47)                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Jobs                        | 13 (13 finished, 13 succeeded)                                                                             | 9 (8 finished, 6 succeeded, 1 cancelled)                                                                 |
| Time to preview p50 / p95   | 107.3 s / 1358.8 s (the paid ad render 1358.8 s; the other renders 25.4–117.4 s, except 809.1 s, see #190) | 41.2 s / 555.3 s (part B 555.3 s, or 484.1 s without the `job.start` gate wait; cached re-render 41.2 s) |
| Success rate                | 100%                                                                                                       | 75% (the two failed jobs are the first part A attempts, one stopped by a missing storage bucket)         |
| Video rendered              | 360 s (19 renders; final deliverable 3 × 20 s ads + 15 s motion graphic)                                   | 30 s (2 renders of the 15 s scene)                                                                       |
| Cost per video minute       | 143.2 ¢ (859 ¢ recorded / 360 s)                                                                           | 468.0 ¢ (234 ¢ recorded / 30 s)                                                                          |
| Agent cost per video second | 0 ¢ (no `agent.run` events, see #191)                                                                      | 0 ¢ (2 `agent.run` events at 0 ¢, see #191)                                                              |
| Revision rounds             | 2 (two `patch` versions)                                                                                   | 5 (two `patch` versions, three storyboard gates sent back)                                               |
| Asset reuse                 | 47/56 (83.9%); stages from cache 12/90                                                                     | 32/32 (100%); stages from cache 6/48                                                                     |
| Quality failures (QA)       | 0 of 9 QA runs                                                                                             | 0 of 2 QA runs                                                                                           |
| Human intervention points   | 1 (storyboard review)                                                                                      | 10 (7 creative gates, 2 `job.start`, 1 storyboard review)                                                |
| Owner quality rating        | chờ chủ sở hữu                                                                                             | chờ chủ sở hữu                                                                                           |

Limits of these numbers. Each item below is a gap between what the database records and what happened in the demo:

- Recorded cost uses multix list prices, not what the provider billed (#187). The spend ledger of the demos puts the real cost at $8.43 for marketing and $2.42 for anime.
- `provider_executions` has no rows for media generation (#186), so latency and attempts per provider are not measured.
- The marketing revision count misses every round that did not create a `patch` version or an approval (#188). The demo record lists 7 rounds:
  - 2 storyboard patches;
  - 3 re-renders after quality failures found by a human;
  - 2 voice-over redos.
- The QA hard gate passed every render the owner rejected (#189). The gate measures only technical properties; see [QA.md](QA.md).
- The final ad render lost two attempts to a worker restart (#190). That is why one cached re-render took 809.1 s.
