# MCP API

The northbound contract AI clients see at one Streamable HTTP endpoint:
`${STUDIX_APP_URL}/mcp` (production: `https://app.studix.digitop.ai/mcp`, dev:
`https://dev-app.studix.digitop.ai/mcp`).

Source of truth for exact field shapes: the zod schemas in
`packages/shared/src` (envelope, `ErrorCode`), `packages/video-ir/src`
(briefs, specs, IR) and the tool registrations in `apps/mcp-server/src`.
`studix_inspect` returns the live JSON Schemas at runtime. This page records the
intent and the stable rules; it does not duplicate field lists.

## Transport and auth

- Transport: MCP Streamable HTTP, served with `@modelcontextprotocol/server` v2
  on Express 5 ([ADR-0004](decisions/0004-mcp-in-mcp-gateway-trust-boundary.md)).
- Auth: `Authorization: Bearer stx_<env>_<random>`, a workspace API key created
  in the dashboard. The key resolves to exactly one workspace; every tool call
  runs in that tenant. Missing, unknown or revoked keys fail with
  `UNAUTHENTICATED`; a key without the needed scope fails with `FORBIDDEN`.
- Inbound OAuth for AI clients is planned, not shipped
  ([ADR-0006](decisions/0006-auth-and-oauth-client-compatibility.md)).
- Requests whose `Host`/`Origin` is not derived from the configured
  `STUDIX_*_URL` values are rejected.

## Output envelope

Every tool returns the same envelope as structured content:

```text
{
  status,          // outcome of this call
  data,            // tool-specific payload (typed per tool)
  next[],          // suggested follow-up actions (tool + arguments hint)
  error?: { code, message, retryable, suggestedAction },
  traceId          // correlates with dashboard traces
}
```

Rules:

- `next[]` is always present; an empty list means nothing further is expected.
- `error` is present only on failure. Clients branch on `error.code`, never on
  `message` text.
- `retryable: true` means the same call may succeed later unchanged; follow
  `suggestedAction` otherwise.
- Media is returned as signed URLs or asset refs, never inline binary.

### Error codes

| Code                | Meaning                                                              | Typical retryable |
| ------------------- | -------------------------------------------------------------------- | ----------------- |
| `VALIDATION`        | Input failed schema or business validation                           | no                |
| `NOT_FOUND`         | Resource absent in this workspace (also used for other tenants' ids) | no                |
| `UNAUTHENTICATED`   | Missing, unknown or revoked API key                                  | no                |
| `FORBIDDEN`         | Key or grant lacks permission; denied connector tool                 | no                |
| `CONFLICT`          | Idempotency or version conflict                                      | no                |
| `BUDGET_EXCEEDED`   | Job or workspace budget would be exceeded                            | no                |
| `TIMEOUT`           | Operation exceeded its deadline                                      | yes               |
| `CANCELLED`         | Job or call was cancelled                                            | no                |
| `RATE_LIMITED`      | Workspace or upstream rate limit                                     | yes               |
| `PROVIDER_ERROR`    | Model, media or downstream MCP provider failed                       | depends           |
| `UNAVAILABLE`       | Dependency temporarily unavailable                                   | yes               |
| `APPROVAL_REQUIRED` | Action needs a recorded human approval                               | no                |
| `INTERNAL`          | Unexpected server error; quote `traceId`                             | depends           |

The union is `ErrorCode` in `packages/shared`; the `retryable` column is a
guide, the per-error value is authoritative.

## P0 native tools

| Tool                  | Purpose                                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `studix_inspect`      | Capabilities handshake: server and schema versions, templates, formats, limits, constraints and JSON Schemas for inputs such as the creative spec. Call this first.                                                                |
| `studix_create_video` | One goal -> async workflow. Accepts a brief (natural language, Vietnamese or English) or a validated spec from the host; an optional idempotency key makes retries safe. Returns `projectId`, `jobId`, `stage` and `next` quickly. |
| `studix_get_job`      | Job stage, progress, recommended next action, and signed preview/final URLs when ready.                                                                                                                                            |
| `studix_get_project`  | Project, versions, latest job and renders with signed URLs.                                                                                                                                                                        |
| `studix_cancel_job`   | Cancel a queued or running job; a running stage is aborted and the job ends `cancelled`.                                                                                                                                           |
| `studix_retry_job`    | Requeue a `failed` job after its cause is fixed (see [Retrying a failed job](#retrying-a-failed-job)).                                                                                                                             |
| `studix_approve`      | Record a decision on a pending approval (for example `video.publish`). Only a human user may approve; an API key gets `FORBIDDEN`.                                                                                                 |
| `studix_feedback`     | Feedback on one target of the current version: `shotId`, `sceneId`, `assetId`, or `startMs` with `endMs`. Always stored as a comment. With a `patch`, it makes a new version and queues a render job. Async.                       |
| `studix_render`       | Queue a render of the current version, or of a given `versionId`, at a `renderPreset`. Returns `jobId`; poll `studix_get_job` for the MP4 URL. Async.                                                                              |

Every tool that touches a project returns its ids, `next[]` and `reviewUrl`
(`${STUDIX_APP_URL}/#/projects/<projectId>/review`), the dashboard page where a
person reviews and approves the storyboard. Signed preview URLs are included
when a finished render exists (`studix_get_job` `video.url`, `studix_get_project`
`renders[].url`, and `studix_feedback` `previewUrl` for a comment without a patch).

Behavior notes:

- Passing a host-authored spec skips internal planning; Studix does not pay a
  creative model a second time.
- Without a spec, one `DecisionRouter.decide("video.brief")` call turns the
  prompt into a brief draft (route set by `DECISION_ROUTES`, e.g.
  `video.brief=openrouter>rules`; the rules fallback is free and deterministic),
  then the brand-intro template builds the IR without a second model call
  ([ADR-0003](decisions/0003-jev-decision-provider-adapter-and-routing-fallback.md)).
- `studix_create_video` inputs: `prompt` or `brief` (one is required), `spec`,
  `title`, `idempotencyKey`, `budgetCents`, `deadlineSeconds` (10 s to 7 days;
  past it the job fails with `TIMEOUT`), `renderPreset`, `planner`,
  `workflowTemplate`.
- `workflowTemplate` is a pack id from the registry in `@studix/skills`
  (`studix_inspect` lists them under `skills`); it defaults to `brand-intro`.
  An unknown id fails with `VALIDATION` before anything is stored, with
  `error.details.available` listing the registered ids. Adding a pack needs
  only `registerPack`; the server does not change. The Claude `planner` writes
  the IR itself, so it is refused together with a non-default pack.
- `workflowTemplate: "marketing-video"` makes one ad per `brief.directions[]`
  entry (1 to 6), all sharing the brief's brand, language, format and length
  (default 20 s, 9:16). The create job writes the script, generates one
  storyboard frame per beat and stops with the project `in_review`; it runs no
  image-to-video, voice or music. Frame prompts describe the scene only. Beats
  derived from a direction never carry its hook or messages, and the brand name
  and tagline are removed from every frame prompt, because the HyperFrames
  overlay sets the logo, wordmark and copy. Each ad's voice-over must fit about three
  words a second of its length, or the job fails with `VALIDATION` before any
  paid call. After a person approves the storyboard, `studix_render` animates
  the frames, adds voice-over, music and SFX, then renders, QA-gates and
  uploads one file per ad (`renders[]`). Any image-to-video or audio stage
  without an approved storyboard fails with `APPROVAL_REQUIRED`.
- `workflowTemplate: "motion-graphic"` builds a kinetic HTML/GSAP graphic
  (6 to 60 s, default 15 s) in the style profile that best matches the brief,
  with a generated voice-over and burned captions, then renders, QA-gates and
  uploads it in one job. It has no image-to-video.
- `planner: {runtime: "claude", providerConnectionId}` is opt-in. The worker
  then plans the VideoIR with the Claude Agent SDK, billed to that Anthropic API
  key ([ADR-0011](decisions/0011-claude-agent-runtime-and-provider-auth.md)).
  Connection ids are listed in the dashboard under **AI & Providers**.
  - Refused with `VALIDATION` together with `spec`, because a spec is not planned.
  - Refused at creation with `UNAVAILABLE` when the operator has not enabled
    `STUDIX_CLAUDE_PLANNER`, or when the connection is missing, revoked or in
    another workspace; `FORBIDDEN` when it is someone else's personal key.
    A job created with an `stx_` key can use workspace keys only.
  - There is no fallback: if Claude cannot plan (rejected key, budget, invalid
    output), the job fails with that error instead of using the default planner.
- Publishing is gated: a publish job waits in `waiting_approval` until a human
  approves it in the dashboard.
- Re-sending `studix_create_video` with the same idempotency key in the same
  workspace returns the original job instead of a new one.

### Retrying a failed job

A `failed` job is terminal for the worker, but `studix_retry_job` (`POST /api/jobs/:jobId/retry` on the dashboard API) requeues it as the same job once the cause is fixed, for example a storage bucket that was missing after the provider had already charged for the media.

- Stages that succeeded keep their outputs and are not run again.
- The failed stage reuses its media job journal: upstream jobs that completed are collected, not submitted again, and a call that is still in flight is resumed by its upstream id.
- Usage events keep their `dedupeKey`, which is tied to the upstream job, so the resume bills no call twice.
- Gates already decided on the job (approved, or consumed) are read from the database and are not asked again.
- The job gets a fresh allowance of 3 attempts, and a deadline starts again with the window it was created with. The budget is not reset: spend so far still counts against `budgetCents`.
- Only a `failed` job can be retried (any other status returns `CONFLICT`), `video.publish` jobs cannot (`VALIDATION`: a publish is not idempotent, so start a new one), and the caller needs the `job:retry` permission (owner, admin and editor roles; API keys need the scope).
- The action is audited as `job.retried`. A failed job's `next` list suggests the tool.

### Feedback, render and storyboard approval

- `studix_feedback` with no `patch` stores a comment and returns
  `allowedPaths`: the JSON pointers a patch for that target may touch (the
  shot, the scene with `/timeline`, the asset, or the shots overlapping the time
  range). `next[]` suggests the call with a patch.
- A `patch` is a JSON Patch (`ops[]`) on the VideoIR with absolute pointers. An
  op outside `allowedPaths` fails with `VALIDATION`, with `details.outside` and
  `details.allowedPaths`, and nothing is stored. A valid patch becomes a new
  immutable version that is current from then on. Only the nodes that depend on
  the change are invalidated, and they are returned as `invalidated`
  (`shot:<id>`, `scene:<id>`, ...). The render job reuses cached stage work for
  everything else.
- `baseVersionId` is optional. When it is not the current version, the call
  fails with `CONFLICT`, so feedback is never applied to a newer version than
  the one it was written for.
- With an `idempotencyKey`, `studix_feedback` is safe to retry. The key is
  stored on the new version together with the comment id, so a call that
  stopped after the version was stored is completed by the retry (comment,
  revisions, job), even when `baseVersionId` is no longer current. Retries,
  including concurrent ones, return the same version, comment and job, with
  `replayed: true`.
- A comment without a patch creates no version or job, so its key is stored on
  the comment itself (unique per project). A retry returns the stored comment
  with `replayed: true`; the same key with a different comment or with a patch
  is `CONFLICT`.
- `studix_render` renders a stored version, and that version becomes current.
  Both tools accept `idempotencyKey` and `budgetCents`. A budget above the
  approval threshold parks the job in `waiting_approval`.
- Permissions: a patch or a render needs `project:write`. A comment needs
  `project:write` or `approval:decide`. Other tenants' projects are `NOT_FOUND`.
- Approving the storyboard, its scenes and its shots is a human gate. It is
  done in the dashboard at `reviewUrl` and is not exposed as an MCP tool.
  Stages that generate per-shot media from the plan, such as image-to-video,
  run only after the storyboard is `approved`. Otherwise the job fails with
  `APPROVAL_REQUIRED`. A patch that changes a shot puts that shot, its scene
  and the storyboard back in review. "Rendered" never means "approved".

### Agent stage handoff tools

A creative agent stage (for example `brand-intro.script`) runs in one of two
modes under the same contract: the stage's input schema, output schema and
limits ([ADR-0015](decisions/0015-agent-stage-caps-and-host-handoff.md)). The
job payload's `agentMode` picks the mode. `harness` (the default) runs the
Claude agent inside the worker under hard caps. `host` hands the stage to the
MCP client's own agent: the job moves to `waiting_host`, and `studix_get_job`
returns `next[]` pointing at `studix_list_agent_tasks`.

| Tool                       | Arguments                               | Returns                                                                                           |
| -------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `studix_list_agent_tasks`  | `jobId?`, `limit?`, `cursor?`           | Tasks waiting for a host output: `id`, `jobId`, `stage`, `attempt`, `status`, `expiresAt`.        |
| `studix_get_agent_task`    | `taskId`                                | `instructions`, `input`, `outputSchema` (JSON Schema), `limits` and the `attempt` to submit with. |
| `studix_submit_agent_task` | `taskId`, `attempt`, `output`, `usage?` | `{task, replayed}`. An accepted output requeues the job, which continues from the next stage.     |
- `limits` holds `maxTurns`, `maxTokens`, `maxCostCents`, `timeoutMs` and
  `tools`, the allowlist of tool names the agent may call. Only the time limit
  is enforced in host mode: the task expires at `expiresAt`. The other limits
  are the budget the harness would have; respect them.
- `output` is checked against the stage's output schema, the same schema the
  worker applies. A mismatch fails with `VALIDATION`, `details.reason:
  "invalid_output"` and `details.issues`, and nothing is stored, so fix the
  output and submit again. Secrets in the output are redacted before it is
  stored.
- Submissions are idempotent per attempt. The same output again returns
  `replayed: true`; a different one is `CONFLICT` with
  `details.reason: "already_submitted"`. A wrong `attempt` is `CONFLICT`
  `stale_attempt`, a job that stopped waiting is `CONFLICT` `not_waiting`, and a
  task past `expiresAt` is `TIMEOUT` `expired`.
- `usage` (`turns`, `inputTokens`, `outputTokens`, `model`) is optional and is
  recorded in the ledger with zero cost. Studix pays nothing for host work.
- Reading needs `project:read`; submitting needs `project:write`. Other
  workspaces' tasks are `NOT_FOUND`.
- When a stage reaches a limit (any cap in the harness, the time limit in host
  mode), the job does not fail. It parks in `waiting_approval` with an
  `agent.overrun` approval. A person approving it in the dashboard grants one
  more run with every limit doubled; rejecting it fails the job with
  `FORBIDDEN`.

## P0 meta-tools (MCP-in-MCP)

Third-party tools registered in the workspace are reached only through these
three tools; they never appear in `tools/list`.

| Tool                  | Arguments                    | Returns                                                                                               |
| --------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `studix_tool_search`  | `query`, `server?`, `limit?` | Permitted tools as qualified names (`server.tool`) with compact summaries. Denied tools are absent.   |
| `studix_tool_inspect` | `tool`                       | The tool's actual input schema, annotations, permission and availability.                             |
| `studix_tool_execute` | `tool`, `arguments`          | Routed result or typed error, `traceId`, `next`. Large results are truncated or stored as asset refs. |

Every execute is re-authorized at call time; a grant revoked after search
returns `FORBIDDEN`. See [SECURITY.md](SECURITY.md#mcp-in-mcp-connectors).

## Roadmap tools

Not implemented; do not depend on them. Capabilities are added to the contract
before new tools are created.

| Tool                 | Intent                                                    | Phase        |
| -------------------- | --------------------------------------------------------- | ------------ |
| `studix_edit_video`  | Revise a version from free-form feedback without a patch  | P1           |
| `studix_list_assets` | List workspace assets                                     | P1           |
| `studix_search`      | Search projects, scenes, assets                           | P1-P2        |
| `studix_publish`     | Publish an approved final; fails closed without approval  | P2           |
| `studix_code`        | Sandboxed Code Mode over the gateway, feature-flagged off | P2, optional |

## Connecting a client

You need the MCP URL and a workspace API key (`stx_...`) from the dashboard.
Treat the key as a password: do not paste it into a chat message.

### Claude Code

```bash
claude mcp add --transport http studix https://app.studix.digitop.ai/mcp \
  --header "Authorization: Bearer stx_..."
```

Then run `/mcp` in Claude Code to confirm `studix` is connected.

### Claude Desktop and claude.ai custom connectors

Custom connectors added in Claude's settings authenticate with OAuth, not a
static header. Until inbound OAuth ships (ADR-0006), use one of:

- **Claude Desktop local config** through a header-capable bridge such as
  `mcp-remote`, in `claude_desktop_config.json`:

  ```json
  {
    "mcpServers": {
      "studix": {
        "command": "npx",
        "args": ["mcp-remote", "https://app.studix.digitop.ai/mcp",
                 "--header", "Authorization:${STUDIX_API_KEY}"],
        "env": { "STUDIX_API_KEY": "Bearer stx_..." }
      }
    }
  }
  ```

- **Claude Code** as above.

The custom-connector path is part of the OAuth verification plan in ADR-0006.

### ChatGPT

ChatGPT connectors (developer mode) also expect OAuth or no auth, so they wait
on ADR-0006. Programmatic use works now through the OpenAI Responses API remote
MCP tool, which accepts request headers:

```json
{
  "type": "mcp",
  "server_label": "studix",
  "server_url": "https://app.studix.digitop.ai/mcp",
  "headers": { "Authorization": "Bearer stx_..." },
  "require_approval": "never"
}
```

Verify the current field names against OpenAI's documentation before relying on
this snippet; it is not covered by Studix CI.

### TypeScript SDK

```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL("https://app.studix.digitop.ai/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.STUDIX_API_KEY}` } },
  }),
);
const job = await client.callTool({
  name: "studix_create_video",
  arguments: { prompt: "Video giới thiệu thương hiệu cà phê Sương Mai, 15 giây, dọc 9:16" },
});
```

The repo's TS client tests (`apps/mcp-server/test/*.integration.test.ts`) are
the executable reference.

### Python SDK

```python
import asyncio, os
from mcp import ClientSession
from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client

async def main():
    headers = {"Authorization": f"Bearer {os.environ['STUDIX_API_KEY']}"}
    async with create_mcp_http_client(headers=headers) as http:
        async with streamable_http_client("https://app.studix.digitop.ai/mcp", http_client=http) as streams:
            async with ClientSession(streams[0], streams[1]) as s:
                await s.initialize()
                print(await s.call_tool("studix_inspect", {}))

asyncio.run(main())
```

Verified with `mcp==2.3.0`
(`apps/mcp-server/test/python/python-sdk-smoke-client.py`, run by the
integration suite through `uv`).

### Example prompt

> Dùng Studix tạo một video giới thiệu thương hiệu cà phê "Sương Mai", dài 15
> giây, khung dọc 9:16, tông màu nâu kem, có logo ở cảnh cuối và câu slogan
> "Đánh thức buổi sáng". Theo dõi tiến độ và gửi tôi link xem trước khi xong.

The client should call `studix_inspect`, then `studix_create_video`, then poll
`studix_get_job` until a preview URL appears.

### Troubleshooting

| Symptom                         | Likely cause                                        | Fix                                                                                    |
| ------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `UNAUTHENTICATED` on every call | Missing `Bearer ` prefix, wrong key, or key revoked | Recreate the key in the dashboard; check the header value                              |
| `FORBIDDEN`                     | Key scope lacks the tool, or connector tool denied  | Adjust key scope or connector grant in the dashboard                                   |
| Client shows no tools           | Wrong URL (missing `/mcp`) or blocked by host check | Use the exact URL from the dashboard                                                   |
| Connection drops on long calls  | Proxy buffering or timeout on the client side       | Studix tools return fast; poll `studix_get_job` instead of waiting                     |
| `BUDGET_EXCEEDED`               | Workspace or job budget                             | Lower scope (duration, formats) or raise the budget                                    |
| `APPROVAL_REQUIRED`             | Publish or high-cost step                           | Approve in the dashboard, then retry                                                   |
| Job stuck in one stage          | Worker down or lease recovery pending               | Check `traceId` in the dashboard; operators see [DEPLOYMENT.md](DEPLOYMENT.md#runbook) |
| Search finds no connector tool  | Connector disabled, not refreshed, or tool denied   | Test/refresh the connector in the dashboard                                            |
