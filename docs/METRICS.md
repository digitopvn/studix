# Metrics

Baseline definitions for the P0 vertical slice. Every metric is computed from
traces and records Studix already writes (`packages/observability` spans,
`jobs`, `provider executions`, `usage events` in Postgres). No metric needs
extra client instrumentation.

A render that succeeds is **not** a video that was approved. Success metrics
below say which one they count.

## Definitions

### Pipeline

| Metric | Definition | How measured |
|---|---|---|
| Brief-to-preview latency | Time from `studix_create_video` accepted to a preview render stored | `job.createdAt` to the preview render's stored timestamp; report p50/p95 |
| Job success rate | Jobs reaching `succeeded` / jobs created, excluding cancelled | Count by terminal state per window |
| Approval rate | Previews later approved / previews produced | Approval records joined to renders; separate from success rate |
| Model calls per job | Count of decision and agent model calls in one job | Provider execution spans per `jobId` |
| Cost per job | Sum of COGS for one job | Sum of usage events per `jobId`; COGS only, not price |
| Retries per job | Stage and provider retries in one job | Retry attempts recorded on spans |
| User steps | Client tool calls plus human dashboard actions from brief to preview | MCP calls per `jobId` + dashboard audit events; target is create + polls only |

### Decision routing (Jev)

| Metric | Definition | How measured |
|---|---|---|
| Decision latency | Time for `DecisionRouter.decide` including retries and fallback | Decision span duration; p50/p95 per decision type and provider |
| Schema-valid rate | Responses valid on first parse / responses received | Validation outcome on decision spans, before retry |
| Provider success rate | Successful decisions / attempts, per provider and model | Attempt spans grouped by `providerId`, `modelId` |
| Fallback rate | Decisions served by a fallback adapter / decisions | `fallbackReason` present on the result |
| Cost per decision | COGS per decision, per provider and model | Usage on decision spans |

### MCP-in-MCP gateway

| Metric | Definition | How measured |
|---|---|---|
| Tool search latency | `studix_tool_search` server time | Span duration; p50/p95 |
| Tool inspect latency | `studix_tool_inspect` server time | Span duration; p50/p95 |
| Tool execute latency | `studix_tool_execute` server time, split into gateway overhead and downstream time | Gateway span minus downstream call span |
| Downstream success rate | Successful downstream calls / executes reaching downstream | Outcome on invocation traces per server |
| Deny rate | Executes denied by policy / execute attempts | Permission verdict on invocation traces |
| `tools/list` size | Number of tools and serialized bytes of the northbound `tools/list` response | Measured by the TS client test against a workspace with the mock connector registered; must not grow with downstream tools |

## Baseline results

Values are filled from the staging demo run. Each filled row must cite its
evidence (trace query or test run) and the commit measured.

| Metric | Value | Sample | Evidence |
|---|---|---|---|
| Brief-to-preview latency (p50/p95) | pending measurement | pending | pending |
| Job success rate | pending measurement | pending | pending |
| Approval rate | pending measurement | pending | pending |
| Model calls per job | pending measurement | pending | pending |
| Cost per job | pending measurement | pending | pending |
| Retries per job | pending measurement | pending | pending |
| User steps | pending measurement | pending | pending |
| Decision latency (p50/p95) | pending measurement | pending | pending |
| Schema-valid rate | pending measurement | pending | pending |
| Provider success rate | pending measurement | pending | pending |
| Fallback rate | pending measurement | pending | pending |
| Cost per decision | pending measurement | pending | pending |
| Tool search latency (p50/p95) | pending measurement | pending | pending |
| Tool inspect latency (p50/p95) | pending measurement | pending | pending |
| Tool execute latency (p50/p95) | pending measurement | pending | pending |
| Downstream success rate | pending measurement | pending | pending |
| Deny rate | pending measurement | pending | pending |
| `tools/list` size (tools / bytes) | pending measurement | pending | pending |
