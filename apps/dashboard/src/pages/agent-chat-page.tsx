import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  type AgentChatEvent,
  type AgentJobStatus,
  type AgentRuntimeInfo,
  type AgentRuntimeName,
  api,
  type CreateVideoRequest,
  type Job,
  type ReasoningEffort,
  streamAgentEvents,
} from "../api-client.ts";
import { ErrorBanner, errorText, Link, StatusBadge, useAsync } from "../ui.tsx";
import { navigate } from "../use-hash-route.ts";

/*
 * New video as a conversation: every message starts a skill-agent job on the chosen runtime, and the page shows
 * that agent's own stream (text, reasoning, tool calls) as it happens. Nothing here plans steps for the agent.
 */

const PACK = "skill-agent";
const RUNTIME_LABELS: Record<AgentRuntimeName, string> = { claude: "Claude", codex: "Codex", pi: "Pi" };
const EFFORTS: ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const MEDIA = /[\w./-]+\.(png|jpe?g|webp|gif|mp3|wav|m4a|mp4|webm|mov)\b/gi;
const PROMPT_MAX = 4000;

type AspectRatio = NonNullable<CreateVideoRequest["aspectRatio"]>;

interface Turn {
  jobId: string;
  prompt: string;
  runtime?: AgentRuntimeName;
}

const threadKey = (rootJobId: string) => `studix.chat.${rootJobId}`;

function loadThread(rootJobId: string): Turn[] {
  try {
    const raw = localStorage.getItem(threadKey(rootJobId));
    const turns = raw ? (JSON.parse(raw) as Turn[]) : [];
    return turns.length > 0 ? turns : [{ jobId: rootJobId, prompt: "" }];
  } catch {
    return [{ jobId: rootJobId, prompt: "" }];
  }
}

function saveThread(rootJobId: string, turns: Turn[]) {
  try {
    localStorage.setItem(threadKey(rootJobId), JSON.stringify(turns));
  } catch {
    // The thread still works for this visit; only a reload loses the earlier turns.
  }
}

/** A follow-up is a new run; it carries the conversation so the agent revises instead of starting over. */
function followUpPrompt(turns: Turn[], summaries: Record<string, string>, message: string): string {
  const history = turns
    .map((t, i) => {
      const said = summaries[t.jobId];
      return `Request ${i + 1}: ${t.prompt}${said ? `\nAgent result ${i + 1}: ${said}` : ""}`;
    })
    .join("\n\n");
  const text = `Revise the video from this conversation.\n\n${history}\n\nNew request: ${message}`;
  return text.length <= PROMPT_MAX ? text : `${text.slice(0, 600)}\n…\n${text.slice(-(PROMPT_MAX - 610))}`;
}

export function AgentChatPage({ threadId }: { threadId?: string }) {
  const [turns, setTurns] = useState<Turn[]>(() => (threadId ? loadThread(threadId) : []));
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTurns(threadId ? loadThread(threadId) : []);
  }, [threadId]);

  const last = turns.at(-1);
  const busy = last ? running[last.jobId] !== false : false;

  function started(turn: Turn) {
    const next = [...turns, turn];
    const root = next[0]?.jobId ?? turn.jobId;
    saveThread(root, next);
    setTurns(next);
    if (!threadId) navigate(`/chat/${root}`);
  }

  return (
    <div className="chat">
      <div className="chat-thread">
        {turns.length === 0 && (
          <div className="chat-empty">
            <h1>What video should we make?</h1>
            <p className="muted">
              Describe it. The agent you pick writes the motion, audio and edit itself in a sandbox, and you
              see every step it takes. Reply to revise.
            </p>
          </div>
        )}
        {turns.map((turn) => (
          <TurnView
            key={turn.jobId}
            turn={turn}
            onSummary={(text) => setSummaries((s) => ({ ...s, [turn.jobId]: text }))}
            onRunning={(value) => setRunning((r) => ({ ...r, [turn.jobId]: value }))}
            onActivity={() => bottom.current?.scrollIntoView({ block: "end" })}
          />
        ))}
        <div ref={bottom} />
      </div>
      <Composer
        busy={busy}
        followUp={turns.length > 0}
        buildPrompt={(message) => (turns.length > 0 ? followUpPrompt(turns, summaries, message) : message)}
        onStarted={started}
      />
    </div>
  );
}

interface ToolCard {
  kind: "tool";
  id: string;
  name: string;
  args?: unknown;
  status: "running" | "ok" | "error";
  result?: string;
}

type Block = { kind: "message" | "reasoning"; text: string } | ToolCard | { kind: "artifact"; name: string };

interface RunState {
  blocks: Block[];
  usage?: Extract<AgentChatEvent, { type: "usage" }>;
  runtime?: { name: string; model?: string };
  error?: string;
}

function reduce(state: RunState, event: AgentChatEvent): RunState {
  const blocks = [...state.blocks];
  const tail = blocks.at(-1);
  switch (event.type) {
    case "message":
    case "reasoning":
      if (tail?.kind === event.type) blocks[blocks.length - 1] = { ...tail, text: tail.text + event.delta };
      else blocks.push({ kind: event.type, text: event.delta });
      return { ...state, blocks };
    case "tool_start": {
      // Some runtimes announce a tool again when it completes; the card is keyed by its call id.
      if (blocks.some((b) => b.kind === "tool" && b.id === event.id)) return state;
      blocks.push({ kind: "tool", id: event.id, name: event.name, args: event.args, status: "running" });
      return { ...state, blocks };
    }
    case "tool_end": {
      const i = blocks.findIndex((b) => b.kind === "tool" && b.id === event.id);
      const card: ToolCard = {
        kind: "tool",
        id: event.id,
        name: event.name,
        ...(i >= 0 ? { args: (blocks[i] as ToolCard).args } : {}),
        status: event.ok ? "ok" : "error",
        ...(event.result !== undefined ? { result: event.result } : {}),
      };
      if (i >= 0) blocks[i] = card;
      else blocks.push(card);
      return { ...state, blocks };
    }
    case "artifact":
      blocks.push({ kind: "artifact", name: event.name });
      return { ...state, blocks };
    case "usage":
      return { ...state, usage: event };
    case "status":
      return {
        ...state,
        runtime: { name: event.runtime, ...(event.model ? { model: event.model } : {}) },
        ...(event.error ? { error: event.error } : {}),
      };
  }
}

const FINAL = new Set(["succeeded", "failed", "cancelled"]);

function TurnView({
  turn,
  onSummary,
  onRunning,
  onActivity,
}: {
  turn: Turn;
  onSummary(text: string): void;
  onRunning(value: boolean): void;
  onActivity(): void;
}) {
  const [run, setRun] = useState<RunState>({ blocks: [] });
  const [job, setJob] = useState<AgentJobStatus>();
  const [detail, setDetail] = useState<Job>();
  const [streamError, setStreamError] = useState<unknown>();
  const [stopping, setStopping] = useState(false);
  const callbacks = useRef({ onSummary, onRunning, onActivity });
  callbacks.current = { onSummary, onRunning, onActivity };

  useEffect(() => {
    const controller = new AbortController();
    let lastId: string | undefined;
    let ended = false;
    setRun({ blocks: [] });
    void (async () => {
      // Reconnects resume after the last event shown, so a dropped connection never repeats or skips steps.
      while (!ended && !controller.signal.aborted) {
        try {
          await streamAgentEvents(
            turn.jobId,
            lastId,
            (message) => {
              if (message.kind === "agent") {
                lastId = message.eventId;
                setRun((state) => reduce(state, message.event));
              } else if (message.kind === "job") {
                setJob(message.job);
                callbacks.current.onRunning(!FINAL.has(message.job.status));
              } else {
                ended = true;
              }
              callbacks.current.onActivity();
            },
            controller.signal,
          );
          setStreamError(undefined);
        } catch (e) {
          if (controller.signal.aborted) return;
          setStreamError(e);
        }
        if (!ended) await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (ended && !controller.signal.aborted) {
        const { job: full } = await api.job(turn.jobId).catch(() => ({ job: undefined }));
        if (full) setDetail(full);
      }
    })();
    return () => controller.abort();
  }, [turn.jobId]);

  const reply = run.blocks.filter((b) => b.kind === "message").at(-1);
  useEffect(() => {
    if (reply?.kind === "message") callbacks.current.onSummary(reply.text.slice(0, 600));
  }, [reply]);

  async function stop() {
    setStopping(true);
    try {
      await api.cancelJob(turn.jobId);
    } catch (e) {
      setStreamError(e);
      setStopping(false);
    }
  }

  const live = job ? !FINAL.has(job.status) : true;
  const spent = run.usage?.costCents ?? job?.spentCents ?? 0;
  return (
    <section className="chat-turn">
      {turn.prompt && <div className="chat-bubble chat-user">{turn.prompt}</div>}
      <div className="chat-agent">
        <div className="chat-meta">
          <strong>
            {run.runtime
              ? (RUNTIME_LABELS[run.runtime.name as AgentRuntimeName] ?? run.runtime.name)
              : "Agent"}
          </strong>
          {run.runtime?.model && <span className="muted">{run.runtime.model}</span>}
          {job && (
            <StatusBadge
              status={job.status}
              label={job.stage ? `${job.status} · ${job.stage}` : job.status}
            />
          )}
          <span className="muted" title="Spent / budget">
            ${(spent / 100).toFixed(2)}
            {job?.budgetCents != null ? ` / $${(job.budgetCents / 100).toFixed(2)}` : ""}
            {run.usage
              ? ` · ${run.usage.turns} turns · ${(run.usage.inputTokens + run.usage.outputTokens).toLocaleString()} tok`
              : ""}
          </span>
          <Link to={`/jobs/${turn.jobId}`} className="muted">
            job
          </Link>
          {live && (
            <button type="button" className="secondary small" disabled={stopping} onClick={() => void stop()}>
              {stopping ? "Stopping..." : "Stop"}
            </button>
          )}
        </div>
        {run.blocks.length === 0 && live && (
          <p className="muted chat-wait">Waiting for the agent to start…</p>
        )}
        {run.blocks.map((block, i) => (
          <BlockView key={block.kind === "tool" ? block.id : `${block.kind}-${i}`} block={block} />
        ))}
        {live && run.blocks.length > 0 && (
          <div className="chat-typing" role="status" aria-label="Agent is working" />
        )}
        {job?.error && (
          <p className="banner banner-error" role="alert">
            {job.error.message}
          </p>
        )}
        {streamError !== undefined && <p className="muted">Reconnecting: {errorText(streamError)}</p>}
        {detail?.video && (
          // biome-ignore lint/a11y/useMediaCaption: agent-made videos carry their own burned-in captions.
          <video className="chat-video" src={detail.video.url} controls playsInline />
        )}
        {detail && !detail.video && detail.videoUnavailableReason && (
          <p className="muted">{detail.videoUnavailableReason}</p>
        )}
      </div>
    </section>
  );
}

function mediaNames(text: string): string[] {
  return [...new Set(text.match(MEDIA) ?? [])].slice(0, 8);
}

function BlockView({ block }: { block: Block }) {
  if (block.kind === "message") return <div className="chat-bubble chat-text">{block.text}</div>;
  if (block.kind === "reasoning") {
    return (
      <details className="chat-reasoning" open>
        <summary>Reasoning</summary>
        <p>{block.text}</p>
      </details>
    );
  }
  if (block.kind === "artifact") return <div className="chat-artifact">📎 {block.name}</div>;
  if (block.kind !== "tool") return null;
  const args = block.args === undefined ? "" : JSON.stringify(block.args, null, 2);
  const media = mediaNames(`${args}\n${block.result ?? ""}`);
  return (
    <details className={`chat-tool chat-tool-${block.status}`}>
      <summary>
        <span className="chat-tool-dot" />
        <code>{block.name}</code>
        <span className="muted chat-tool-brief">{toolBrief(block.args)}</span>
        <span className="muted">{block.status === "running" ? "running…" : block.status}</span>
      </summary>
      {args && (
        <>
          <div className="chat-tool-label">Arguments</div>
          <pre>{args}</pre>
        </>
      )}
      {block.result !== undefined && (
        <>
          <div className="chat-tool-label">Result</div>
          <pre>{block.result}</pre>
        </>
      )}
      {media.length > 0 && (
        <div className="chat-media">
          {media.map((name) => (
            <span key={name} className="badge">
              {name}
            </span>
          ))}
        </div>
      )}
    </details>
  );
}

/** One line of what the call does: the command, path or query the agent passed. */
function toolBrief(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const value =
    a.command ?? a.cmd ?? a.path ?? a.file_path ?? a.filePath ?? a.query ?? a.preview ?? a.description;
  const text = typeof value === "string" ? value : Array.isArray(value) ? value.join(" ") : "";
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

function Composer({
  busy,
  followUp,
  buildPrompt,
  onStarted,
}: {
  busy: boolean;
  followUp: boolean;
  buildPrompt(message: string): string;
  onStarted(turn: Turn): void;
}) {
  const [message, setMessage] = useState("");
  const [runtime, setRuntime] = useState<AgentRuntimeName | "">("");
  const [connectionId, setConnectionId] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<ReasoningEffort | "">("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  const [seconds, setSeconds] = useState(10);
  const [language, setLanguage] = useState("vi");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>();
  const runtimes = useAsync(() => api.agentRuntimes());
  const catalog = useAsync(() => api.providerCatalog());

  const list: AgentRuntimeInfo[] = runtimes.data?.runtimes ?? [];
  const usable = list.filter((r) => r.connections.length > 0);
  // Default to the first runtime that can run now.
  useEffect(() => {
    if (!runtime && usable[0]) setRuntime(usable[0].runtime);
  }, [runtime, usable]);
  const info = list.find((r) => r.runtime === runtime);
  const connection =
    info?.connections.find((c) => c.providerConnectionId === connectionId) ?? info?.connections[0];
  const models = useMemo(() => {
    if (!connection) return [];
    if (connection.models.length > 0) return connection.models;
    // Claude has no Pi catalog entry; its models come from the provider catalog.
    return (catalog.data?.providers.find((p) => p.id === connection.provider)?.models ?? []).map((m) => ({
      id: m.id,
      reasoning: m.reasoning,
    }));
  }, [connection, catalog.data]);
  const reasoning = model ? (models.find((m) => m.id === model)?.reasoning ?? false) : true;

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = message.trim();
    if (!text || !connection || !runtime) return;
    setSending(true);
    setError(undefined);
    try {
      const result = await api.createVideo({
        prompt: buildPrompt(text),
        aspectRatio,
        durationMs: Math.round(seconds * 1000),
        language,
        renderPreset: "final",
        workflowTemplate: PACK,
        idempotencyKey: `chat-${crypto.randomUUID()}`,
        agent: {
          runtime,
          providerConnectionId: connection.providerConnectionId,
          ...(model ? { model } : {}),
          ...(effort && reasoning ? { reasoningEffort: effort } : {}),
        },
      });
      setMessage("");
      onStarted({ jobId: result.job.id, prompt: text, runtime });
    } catch (e) {
      setError(e);
    } finally {
      setSending(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  const unavailable = list.filter((r) => r.connections.length === 0);
  return (
    <form className="chat-composer" onSubmit={(e) => void send(e)}>
      <ErrorBanner error={error ?? runtimes.error} />
      <textarea
        rows={3}
        maxLength={PROMPT_MAX}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={onKey}
        placeholder={
          followUp
            ? "Ask for a change: slower intro, warmer colours, new voice-over…"
            : "A 10 s launch video for Acme Coffee: logo reveal, slogan 'Wake up bold', warm palette, upbeat music."
        }
      />
      <div className="chat-controls">
        <fieldset className="chat-runtimes" aria-label="Agent runtime">
          {list.map((r) => {
            const off = r.connections.length === 0;
            return (
              <button
                key={r.runtime}
                type="button"
                aria-pressed={runtime === r.runtime}
                className={`chat-runtime${runtime === r.runtime ? " active" : ""}`}
                disabled={off}
                title={off ? "No usable connection for this runtime. Add one in AI & Providers." : undefined}
                onClick={() => {
                  setRuntime(r.runtime);
                  setConnectionId("");
                  setModel("");
                  setEffort("");
                }}
              >
                {RUNTIME_LABELS[r.runtime]}
              </button>
            );
          })}
        </fieldset>
        {info && info.connections.length > 1 && (
          <select
            aria-label="Connection"
            value={connection?.providerConnectionId ?? ""}
            onChange={(e) => {
              setConnectionId(e.target.value);
              setModel("");
            }}
          >
            {info.connections.map((c) => (
              <option key={c.providerConnectionId} value={c.providerConnectionId}>
                {c.label} ({c.owner === "workspace" ? "workspace" : "personal"})
              </option>
            ))}
          </select>
        )}
        {info && info.connections.length === 1 && connection && (
          <span className="muted small-text">{connection.label}</span>
        )}
        {connection && (
          <select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">Default model</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        )}
        {connection && reasoning && (
          <select
            aria-label="Reasoning effort"
            value={effort}
            onChange={(e) => setEffort(e.target.value as ReasoningEffort | "")}
          >
            <option value="">Default effort</option>
            {EFFORTS.map((x) => (
              <option key={x} value={x}>
                effort: {x}
              </option>
            ))}
          </select>
        )}
        <select
          aria-label="Format"
          value={aspectRatio}
          onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}
        >
          <option value="16:9">16:9</option>
          <option value="9:16">9:16</option>
          <option value="1:1">1:1</option>
        </select>
        <label className="chat-seconds">
          <input
            type="number"
            min={1}
            max={600}
            value={seconds}
            aria-label="Duration in seconds"
            onChange={(e) => setSeconds(Number(e.target.value))}
          />
          s
        </label>
        <select aria-label="Language" value={language} onChange={(e) => setLanguage(e.target.value)}>
          <option value="vi">Tiếng Việt</option>
          <option value="en">English</option>
        </select>
        <button type="submit" disabled={sending || busy || !message.trim() || !connection}>
          {sending ? "Starting..." : busy ? "Agent is working…" : followUp ? "Send" : "Make video"}
        </button>
      </div>
      {runtimes.data && usable.length === 0 && (
        <p className="banner banner-warning">
          No agent runtime can run yet. Connect Anthropic (Claude), OpenAI or ChatGPT (Codex) or a Pi provider
          in <Link to="/providers">AI &amp; Providers</Link>.
        </p>
      )}
      {unavailable.length > 0 && usable.length > 0 && (
        <p className="muted small-text">
          {unavailable.map((r) => RUNTIME_LABELS[r.runtime]).join(", ")} unavailable: no usable connection.{" "}
          <Link to="/providers">Add one</Link>.
        </p>
      )}
    </form>
  );
}
