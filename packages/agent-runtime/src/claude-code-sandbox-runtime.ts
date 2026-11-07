import { randomUUID } from "node:crypto";
import type {
  AgentRunResult,
  AgentRuntime,
  AgentStreamEvent,
  ReasoningEffort,
  TenantContext,
} from "@studix/core";
import { type Clock, registerSecret, StudixError } from "@studix/shared";
import {
  abortReason,
  createBoundedAgentRuntime,
  emitAgentEvent,
  eventText,
  withSpend,
} from "./bounded-agent-runtime.ts";
import {
  type ClaudeCredential,
  claudeEffortOf,
  claudeOutputSchema,
  mapClaudeError,
} from "./claude-agent-runtime.ts";
import { sandboxTaskPrompt } from "./codex-agent-runtime.ts";
import type { PiTaskWorkspaceProvider } from "./pi-task-workspace.ts";
import { SANDBOX_OUTPUT_DIR, SANDBOX_WORK_DIR } from "./sandbox-docker.ts";

/*
 * Claude with full tools: one official Claude Code run (`claude --print`) inside the task's skill sandbox
 * (ADR 0018), so its shell and file tools touch only that container. The credential goes in through stdin
 * to a scratch file the launching shell reads into the environment and deletes, never on a command line.
 */

export const CLAUDE_CODE_SANDBOX_RUNTIME_ID = "claude-code-sandbox";

const TASK_DIR = `${SANDBOX_WORK_DIR}/.task`;
const SAFE_ARG = /^[A-Za-z0-9._:/-]{1,200}$/;

export interface ClaudeCodeSandboxRuntimeOptions {
  workspace: PiTaskWorkspaceProvider;
  model: string;
  reasoningEffort?: ReasoningEffort;
  credential(ctx: TenantContext): Promise<ClaudeCredential>;
  clock?: Clock;
}

interface StreamUsage {
  input_tokens?: number;
  output_tokens?: number;
}

/** Totals of a stream-json run: the `result` event when it came, else the assistant turns seen so far. */
export function claudeStreamUsageOf(lines: readonly string[]) {
  const usage = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let result: Record<string, unknown> | undefined;
  for (const line of lines) {
    let event: { type?: string; message?: { usage?: StreamUsage } } & Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "assistant") {
      usage.turns += 1;
      usage.inputTokens += event.message?.usage?.input_tokens ?? 0;
      usage.outputTokens += event.message?.usage?.output_tokens ?? 0;
    } else if (event.type === "result") {
      result = event;
    }
  }
  if (result) {
    const total = result.usage as StreamUsage | undefined;
    usage.turns = typeof result.num_turns === "number" ? result.num_turns : usage.turns;
    usage.inputTokens = total?.input_tokens ?? usage.inputTokens;
    usage.outputTokens = total?.output_tokens ?? usage.outputTokens;
    usage.costUsd = typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0;
  }
  return { usage, result };
}

interface StreamBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** Live events of one stream-json line; `names` maps tool_use ids to tool names across lines. */
export function claudeStreamEventsOf(line: string, names: Map<string, string>): AgentStreamEvent[] {
  let event: { type?: string; message?: { content?: unknown } };
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  const blocks = Array.isArray(event.message?.content) ? (event.message.content as StreamBlock[]) : [];
  const out: AgentStreamEvent[] = [];
  for (const b of blocks) {
    if (event.type === "assistant" && b.type === "text" && b.text)
      out.push({ type: "message", delta: b.text });
    else if (event.type === "assistant" && b.type === "thinking" && b.thinking)
      out.push({ type: "reasoning", delta: b.thinking });
    else if (event.type === "assistant" && b.type === "tool_use" && b.id && b.name) {
      names.set(b.id, b.name);
      out.push({ type: "tool_start", id: b.id, name: b.name, args: b.input });
    } else if (event.type === "user" && b.type === "tool_result" && b.tool_use_id) {
      const content = Array.isArray(b.content)
        ? (b.content as StreamBlock[]).map((c) => c.text ?? `[${c.type}]`).join("\n")
        : b.content;
      out.push({
        type: "tool_end",
        id: b.tool_use_id,
        name: names.get(b.tool_use_id) ?? "tool",
        ok: b.is_error !== true,
        result: eventText(content),
      });
    }
  }
  return out;
}

function failureOf(result: Record<string, unknown> | undefined, lines: readonly string[], secret: string) {
  const text = String(
    result?.result ?? result?.subtype ?? lines.at(-1) ?? "Claude Code exited without a result",
  );
  const clean = text.split(secret).join("[redacted]").slice(0, 500);
  const status = /\b(401|403|429)\b/.exec(clean)?.[1];
  if (status) return mapClaudeError(Number(status), clean);
  if (/invalid api key|not logged in|oauth token/i.test(clean)) return mapClaudeError(401, clean);
  return new StudixError("PROVIDER_ERROR", `Claude Code failed: ${clean}`);
}

export function createClaudeCodeSandboxRuntime(options: ClaudeCodeSandboxRuntimeOptions): AgentRuntime {
  if (!SAFE_ARG.test(options.model)) throw new StudixError("VALIDATION", "Invalid Claude model id");
  const effort = claudeEffortOf(options.reasoningEffort);
  return createBoundedAgentRuntime({
    id: CLAUDE_CODE_SANDBOX_RUNTIME_ID,
    ...(options.clock ? { clock: options.clock } : {}),
    loop: async (ctx, task): Promise<AgentRunResult> => {
      const credential = await options.credential(ctx);
      registerSecret(credential.secret);
      // A subscription is paid by the plan; an API key's spend is what Claude Code reports.
      const centsOf = (usd: number) => (credential.kind === "subscription" ? 0 : Math.ceil(usd * 100));
      const workspace = await options.workspace.open(ctx, { taskId: randomUUID(), signal: task.signal });
      const lines: string[] = [];
      try {
        const { sandbox } = workspace;
        await sandbox.run(["sh", "-c", `umask 077 && mkdir -p ${TASK_DIR} ${SANDBOX_OUTPUT_DIR}`]);
        await sandbox.run(["sh", "-c", `umask 077 && cat > ${TASK_DIR}/credential`], {
          stdin: credential.secret,
        });
        await sandbox.run(["sh", "-c", `cat > ${TASK_DIR}/prompt.md`], {
          stdin: sandboxTaskPrompt(task, workspace),
        });
        if (task.outputSchema) {
          await sandbox.run(["sh", "-c", `cat > ${TASK_DIR}/schema.json`], {
            stdin: JSON.stringify(claudeOutputSchema(task.outputSchema)),
          });
        }
        const variable = credential.kind === "subscription" ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY";
        const args = [
          "claude --print --output-format stream-json --verbose",
          `--model ${options.model}`,
          `--max-turns ${task.maxTurns}`,
          `--max-budget-usd ${(task.maxCostCents / 100).toFixed(2)}`,
          ...(effort ? [`--effort ${effort}`] : []),
          ...(task.outputSchema ? [`--json-schema "$(cat ${TASK_DIR}/schema.json)"`] : []),
          '--setting-sources ""',
          "--no-session-persistence",
          // The container is the sandbox: every tool is allowed inside it, nothing outside it is reachable.
          "--dangerously-skip-permissions",
          `< ${TASK_DIR}/prompt.md`,
        ];
        const script =
          `${variable}="$(cat ${TASK_DIR}/credential)"; rm -f ${TASK_DIR}/credential; export ${variable}; ` +
          `DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 exec ${args.join(" ")}`;
        let pending = "";
        const toolNames = new Map<string, string>();
        const report = () => {
          const { usage } = claudeStreamUsageOf(lines);
          task.reportUsage({ ...usage, costCents: centsOf(usage.costUsd), model: options.model });
        };
        const { exitCode } = await sandbox.exec(script, {
          cwd: SANDBOX_WORK_DIR,
          signal: task.signal,
          onData(chunk) {
            pending += chunk.toString("utf8");
            const parts = pending.split("\n");
            pending = parts.pop() ?? "";
            const fresh = parts.filter((l) => l.trim());
            lines.push(...fresh);
            for (const line of fresh) {
              for (const e of claudeStreamEventsOf(line, toolNames)) emitAgentEvent(task, e);
            }
            if (fresh.some((l) => l.includes('"type":"assistant"') || l.includes('"type":"result"')))
              report();
          },
        });
        if (pending.trim()) lines.push(pending);
        if (task.signal.aborted) throw abortReason(task.signal);
        const { usage, result } = claudeStreamUsageOf(lines);
        const spent = { ...usage, costCents: centsOf(usage.costUsd), model: options.model };
        if (exitCode !== 0 || !result || result.is_error === true || result.subtype !== "success") {
          throw withSpend(failureOf(result, lines, credential.secret), spent);
        }
        let output: unknown = result.structured_output ?? String(result.result ?? "").trim();
        if (task.outputSchema && result.structured_output === undefined) {
          try {
            output = JSON.parse(String(result.result ?? ""));
          } catch {
            throw withSpend(
              new StudixError("PROVIDER_ERROR", "Claude Code did not return JSON for the output schema"),
              spent,
            );
          }
        }
        const files = await workspace.collect();
        if (files.length > 0) {
          output =
            output !== null && typeof output === "object" && !Array.isArray(output)
              ? { ...output, files }
              : { reply: output, files };
        }
        return { output, ...spent };
      } finally {
        await workspace.close();
      }
    },
  });
}
