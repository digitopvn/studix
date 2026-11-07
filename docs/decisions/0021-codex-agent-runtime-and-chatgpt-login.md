# ADR-0021: Codex agent runtime and ChatGPT sign-in

## Context

Agent stages ran on Pi (any catalog provider) or Claude. Users with a ChatGPT plan wanted to run
those stages on that plan, and MCP hosts wanted to pick the runtime, connection, model and effort per
job instead of relying on workspace defaults.

## Decision

- A third runtime, `codex`, runs one `codex exec --json` per task inside the task's skill sandbox
  ([ADR-0018](0018-skill-sandbox.md)). The Codex CLI is pinned in `docker/sandbox.Dockerfile`
  (`CODEX_VERSION`). Usage comes from the `turn.completed` events.
- An `openai` connection can serve `codex` in two ways: an OpenAI API key with the `codex` runtime
  enabled, or a ChatGPT sign-in (device code, `authMethod: "oauth_subscription"`, `billing:
  "subscription"`, runtimes fixed to `["codex"]`). The tokens are sealed like any key
  ([ADR-0016](0016-provider-connections-runtimes-and-model-preferences.md)); the flow state is a
  sealed, 15-minute token bound to the user and workspace, so the server keeps no flow table.
- The worker writes the login into a scratch `CODEX_HOME` in the sandbox through stdin and reads it
  back after the run, storing a rotated refresh token.
- `studix_create_video` takes `agent: {runtime, providerConnectionId, model?, reasoningEffort?}`,
  validated against the connection and the runtime's model list, and stored on the job. `planner`
  stays as a Claude alias. `studix_list_agent_runtimes` lists the choices, and
  `studix_submit_agent_task` accepts the same `agent` declaration from a host.

## Consequences

- Codex needs `STUDIX_SANDBOX=docker`; without it a codex job fails before it runs.
- A ChatGPT-plan run costs Studix nothing and is recorded at cost 0; the plan's own limits surface as
  `RATE_LIMITED`.
- The sign-in uses OpenAI's public Codex client id. If OpenAI changes that flow, the start route fails
  and API-key connections keep working.

## Alternatives considered

- Running Codex on the worker host: rejected, its shell tools would reach the worker's secrets.
- A server-side flow table: rejected, the sealed flow token needs no cleanup.
- Routing ChatGPT tokens through Pi: rejected, the subscription only covers the Codex client.
