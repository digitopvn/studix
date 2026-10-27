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

Measured on TOSE staging (`app.studix.digitop.ai`, Development server) at commit
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
`provider_executions` instead of `usage_events.metadata`. A plan stage retried in
the same worker replays the cached decision (`DecisionResult.replayed`) and reports
the original execution id; the ledger keys that usage by the execution id rather
than the attempt, so one provider call is billed once.

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
