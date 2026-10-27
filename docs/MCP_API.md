# MCP API

The northbound contract AI clients see at one Streamable HTTP endpoint:
`${STUDIX_APP_URL}/mcp` (staging: `https://app.studix.digitop.ai/mcp`).

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
| `studix_approve`      | Record a decision on a pending approval (for example `video.publish`). Only a human user may approve; an API key gets `FORBIDDEN`.                                                                                                 |

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
  past it the job fails with `TIMEOUT`), `renderPreset`.
- Publishing is gated: a publish job waits in `waiting_approval` until a human
  approves it in the dashboard.
- Re-sending `studix_create_video` with the same idempotency key in the same
  workspace returns the original job instead of a new one.

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

| Tool                                    | Intent                                                    | Phase        |
| --------------------------------------- | --------------------------------------------------------- | ------------ |
| `studix_edit_video` / `studix_feedback` | Revise a version from feedback or patches                 | P1           |
| `studix_approve`                        | Record an approval through MCP (dashboard first)          | P1           |
| `studix_render`                         | Render a stored version at a chosen quality               | P1           |
| `studix_list_assets`                    | List workspace assets                                     | P1           |
| `studix_search`                         | Search projects, scenes, assets                           | P1-P2        |
| `studix_publish`                        | Publish an approved final; fails closed without approval  | P2           |
| `studix_code`                           | Sandboxed Code Mode over the gateway, feature-flagged off | P2, optional |

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
