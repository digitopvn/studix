import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  type AgentChatEvent,
  type AgentJobStatus,
  type AgentRuntimeInfo,
  type AgentRuntimeName,
  type AgentStreamMessage,
  api,
  type CreateVideoRequest,
  type Job,
  type ReasoningEffort,
  streamAgentEvents,
} from "../api-client.ts";
import { ErrorBanner, errorText, Link, StatusBadge, useAsync } from "../ui.tsx";
import { navigate } from "../use-hash-route.ts";
import { REVISE_DRAFT_KEY } from "./project-view/project-view.tsx";
import { useSkillSuggest } from "./skill-suggest.tsx";

/*
 * New video as a conversation: every message starts a skill-agent job on the chosen runtime, and the page shows
 * that agent's own stream (text, reasoning, tool calls) as it happens. Nothing here plans steps for the agent.
 */

const PACK = "skill-agent";
const RUNTIME_LABELS: Record<AgentRuntimeName, string> = { claude: "Claude", codex: "Codex", pi: "Pi" };
const EFFORTS: ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const MEDIA =
  /(?:https?:\/\/[^\s"'<>)]+?|[\w./-]+)\.(?:png|jpe?g|webp|gif|mp3|wav|m4a|mp4|webm|mov)(?:\?[^\s"'<>)]*)?(?=$|[\s"'<>),\]])/gi;
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

type ComposerPrefs = Partial<{
  runtime: AgentRuntimeName;
  connectionId: string;
  model: string;
  effort: ReasoningEffort | "";
  aspectRatio: AspectRatio;
  seconds: number;
  language: string;
}>;
const PREFS_KEY = "studix.composer";

/** The next video starts with the settings of the last one the user sent. */
function loadComposerPrefs(): ComposerPrefs {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as ComposerPrefs;
  } catch {
    return {};
  }
}

function saveComposerPrefs(prefs: ComposerPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or full storage: the defaults still work.
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

const STARTERS = [
  "A 15 s product teaser for a coffee app, upbeat, 9:16",
  "Explain how solar panels work in 30 s, clean motion graphics",
  "A 10 s logo reveal with a warm cinematic look",
];

function takeReviseDraft(): string {
  try {
    const text = sessionStorage.getItem(REVISE_DRAFT_KEY) ?? "";
    sessionStorage.removeItem(REVISE_DRAFT_KEY);
    return text;
  } catch {
    return "";
  }
}

/** Video lengths offered as one-tap chips; a different saved length shows as an extra chip. */
const LENGTHS = [6, 10, 15, 30];

/** The last few projects, so returning users jump back in without opening Projects. */
function RecentStrip() {
  const { data } = useAsync(() => api.projects());
  const items = data?.items.slice(0, 4) ?? [];
  if (!items.length) return null;
  return (
    <div className="recent-strip">
      <span className="muted small-text">Recent</span>
      {items.map((p) => (
        <a key={p.id} href={`#/projects/${p.id}`} className="recent-chip" title={p.title}>
          {p.title.trim() || "Untitled video"}
        </a>
      ))}
    </div>
  );
}

export function AgentChatPage({ threadId }: { threadId?: string }) {
  const [turns, setTurns] = useState<Turn[]>(() => (threadId ? loadThread(threadId) : []));
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [seed, setSeed] = useState<{ text: string }>();
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
    <div className={turns.length === 0 ? "chat chat-start" : "chat"}>
      <div className="chat-thread">
        {turns.length === 0 && (
          <div className="chat-empty">
            <h1>Make a video.</h1>
            <p className="muted">Describe it. Watch every step. Reply to revise.</p>
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
        seed={seed}
      />
      {turns.length === 0 && (
        <div className="chat-after">
          <div className="starters">
            <span className="muted small-text">Try</span>
            {STARTERS.map((s) => (
              <button key={s} type="button" className="secondary small" onClick={() => setSeed({ text: s })}>
                {s}
              </button>
            ))}
          </div>
          <RecentStrip />
        </div>
      )}
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

type Block =
  | { kind: "message" | "reasoning"; text: string }
  | ToolCard
  | { kind: "artifact"; name: string; url?: string };

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
      blocks.push({ kind: "artifact", name: event.name, url: event.url });
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

export const FINAL = new Set(["succeeded", "failed", "cancelled"]);

/**
 * One job's live agent run: streams its stored events from the start and folds them into blocks. Reconnects resume
 * after the last event shown, so a dropped connection never repeats or skips steps.
 */
export function useAgentRun(jobId: string, onMessage?: (message: AgentStreamMessage) => void) {
  const [run, setRun] = useState<RunState>({ blocks: [] });
  const [job, setJob] = useState<AgentJobStatus>();
  const [ended, setEnded] = useState(false);
  const [streamError, setStreamError] = useState<unknown>();
  const listener = useRef(onMessage);
  listener.current = onMessage;

  useEffect(() => {
    const controller = new AbortController();
    let lastId: string | undefined;
    let done = false;
    setRun({ blocks: [] });
    setEnded(false);
    void (async () => {
      while (!done && !controller.signal.aborted) {
        try {
          await streamAgentEvents(
            jobId,
            lastId,
            (message) => {
              if (message.kind === "agent") {
                lastId = message.eventId;
                setRun((state) => reduce(state, message.event));
              } else if (message.kind === "job") {
                setJob(message.job);
              } else {
                done = true;
              }
              listener.current?.(message);
            },
            controller.signal,
          );
          setStreamError(undefined);
        } catch (e) {
          if (controller.signal.aborted) return;
          setStreamError(e);
        }
        if (!done) await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (done && !controller.signal.aborted) setEnded(true);
    })();
    return () => controller.abort();
  }, [jobId]);

  return { run, job, ended, streamError, setStreamError };
}

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
  const [detail, setDetail] = useState<Job>();
  const [stopping, setStopping] = useState(false);
  const callbacks = useRef({ onSummary, onRunning, onActivity });
  callbacks.current = { onSummary, onRunning, onActivity };
  const { run, job, ended, streamError, setStreamError } = useAgentRun(turn.jobId, (message) => {
    if (message.kind === "job") callbacks.current.onRunning(!FINAL.has(message.job.status));
    callbacks.current.onActivity();
  });

  useEffect(() => {
    if (!ended) return;
    let cancelled = false;
    void api
      .job(turn.jobId)
      .then(({ job: full }) => {
        if (!cancelled) setDetail(full);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ended, turn.jobId]);

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
        {run.blocks.map((block, i, all) => (
          <BlockView
            key={block.kind === "tool" ? block.id : `${block.kind}-${i}`}
            block={block}
            stored={storedMedia(all)}
          />
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

const fileName = (path: string) => path.split(/[?#]/)[0]?.split("/").pop() ?? path;

/**
 * File name → signed URL of every artifact the run stored, so a sandbox path the agent named (for example
 * /work/out/video.mp4 in a Bash command) previews once that file was kept.
 */
export function storedMedia(blocks: readonly Block[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const b of blocks) {
    if (b.kind === "artifact" && b.url) map.set(fileName(b.name), b.url);
  }
  return map;
}

function mediaNames(text: string): string[] {
  return [...new Set(text.match(MEDIA) ?? [])].slice(0, 8);
}

/** Images, video and audio the agent names: a URL plays inline; a sandbox path shows as a name until stored. */
export function MediaStrip({ names, stored }: { names: string[]; stored?: ReadonlyMap<string, string> }) {
  if (!names.length) return null;
  const resolved = [
    ...new Set(names.map((n) => (/^https?:\/\//.test(n) ? n : (stored?.get(fileName(n)) ?? n)))),
  ];
  return (
    <div className="chat-media">
      {resolved.map((name) => {
        const ext = /\.(\w+)(?:\?|$)/.exec(name)?.[1]?.toLowerCase() ?? "";
        const label = name.split(/[?#]/)[0]?.split("/").pop() ?? name;
        if (!/^https?:\/\//.test(name)) {
          return (
            <span key={name} className="badge" title={name}>
              {label}
            </span>
          );
        }
        if (/^(mp4|webm|mov)$/.test(ext)) {
          // biome-ignore lint/a11y/useMediaCaption: agent-made clips carry their own captions.
          return (
            <video
              key={name}
              className="chat-media-item"
              src={name}
              controls
              muted
              playsInline
              preload="metadata"
            />
          );
        }
        if (/^(mp3|wav|m4a)$/.test(ext)) {
          // biome-ignore lint/a11y/useMediaCaption: generated audio has no caption track.
          return <audio key={name} src={name} controls preload="none" />;
        }
        return (
          <a key={name} href={name} target="_blank" rel="noreferrer" title={label}>
            <img className="chat-media-item" src={name} alt={label} loading="lazy" />
          </a>
        );
      })}
    </div>
  );
}

export function BlockView({ block, stored }: { block: Block; stored?: ReadonlyMap<string, string> }) {
  if (block.kind === "message") {
    return (
      <>
        <div className="chat-bubble chat-text">{block.text}</div>
        <MediaStrip names={mediaNames(block.text)} stored={stored} />
      </>
    );
  }
  if (block.kind === "reasoning") {
    return (
      <details className="chat-reasoning" open>
        <summary>Reasoning</summary>
        <p>{block.text}</p>
      </details>
    );
  }
  if (block.kind === "artifact") {
    // A stored artifact carries a signed URL; a bare name is only a path in the sandbox.
    const names = mediaNames(block.url ?? block.name);
    return names.length ? <MediaStrip names={names} /> : <div className="chat-artifact">📎 {block.name}</div>;
  }
  if (block.kind !== "tool") return null;
  const args = block.args === undefined ? "" : JSON.stringify(block.args, null, 2);
  const media = mediaNames(`${args}\n${block.result ?? ""}`);
  return (
    <>
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
      </details>
      <MediaStrip names={media} stored={stored} />
    </>
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
  seed,
}: {
  seed?: { text: string };
  busy: boolean;
  followUp: boolean;
  buildPrompt(message: string): string;
  onStarted(turn: Turn): void;
}) {
  // A revision brief from a project review starts the composer prefilled, once.
  const [message, setMessage] = useState(() => (followUp ? "" : takeReviseDraft()));
  useEffect(() => {
    if (seed) setMessage(seed.text);
  }, [seed]);
  const [last] = useState(loadComposerPrefs);
  const [runtime, setRuntime] = useState<AgentRuntimeName | "">(last.runtime ?? "");
  const [connectionId, setConnectionId] = useState(last.connectionId ?? "");
  const [model, setModel] = useState(last.model ?? "");
  const [effort, setEffort] = useState<ReasoningEffort | "">(last.effort ?? "");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(last.aspectRatio ?? "16:9");
  const [seconds, setSeconds] = useState(last.seconds ?? 10);
  const [language, setLanguage] = useState(last.language ?? "vi");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>();
  const runtimes = useAsync(() => api.agentRuntimes());
  const suggest = useSkillSuggest(message, setMessage);
  const catalog = useAsync(() => api.providerCatalog());

  const list: AgentRuntimeInfo[] = runtimes.data?.runtimes ?? [];
  const usable = list.filter((r) => r.connections.length > 0);
  // Keep the last-used runtime while it can still run; otherwise fall back to the first one that can.
  useEffect(() => {
    if (!runtimes.data) return;
    if (runtime && usable.some((r) => r.runtime === runtime)) return;
    if (usable[0]) {
      setRuntime(usable[0].runtime);
      setConnectionId("");
      setModel("");
      setEffort("");
    }
  }, [runtime, usable, runtimes.data]);
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
        prompt: buildPrompt(suggest.withSkills(text)),
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
      saveComposerPrefs({
        runtime,
        connectionId: connection.providerConnectionId,
        model,
        effort,
        aspectRatio,
        seconds,
        language,
      });
      setMessage("");
      suggest.clear();
      onStarted({ jobId: result.job.id, prompt: suggest.withSkills(text), runtime });
    } catch (e) {
      setError(e);
    } finally {
      setSending(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing || suggest.onKeyDown(e)) return;
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <form className="chat-composer" onSubmit={(e) => void send(e)}>
      <ErrorBanner error={error ?? runtimes.error} />
      {suggest.menu}
      <div className="composer-field">
        {suggest.tags}
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
      </div>
      <div className="chat-controls">
        {/* The agent and model are for people who care; everyone else just writes and presses Make video. */}
        <details className="chat-options">
          <summary>
            AI: {runtime ? RUNTIME_LABELS[runtime] : "Auto"}
            {model ? ` · ${model}` : ""}
            {effort && reasoning ? ` · ${effort}` : ""}
          </summary>
          <div className="chat-options-body">
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
                    title={
                      off
                        ? "No usable connection for this runtime. Add one in Settings → Models & keys."
                        : undefined
                    }
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
          </div>
        </details>
        <select
          aria-label="Format"
          value={aspectRatio}
          onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}
        >
          <option value="16:9">16:9</option>
          <option value="9:16">9:16</option>
          <option value="1:1">1:1</option>
        </select>
        <fieldset className="chat-lengths" aria-label="Video length">
          {(LENGTHS.includes(seconds) ? LENGTHS : [...LENGTHS, seconds].sort((x, y) => x - y)).map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={seconds === n}
              className={`chat-length${seconds === n ? " active" : ""}`}
              onClick={() => setSeconds(n)}
            >
              {n} s
            </button>
          ))}
        </fieldset>
        <select
          aria-label="Narration language"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          <option value="vi">Voice: Tiếng Việt</option>
          <option value="en">Voice: English</option>
        </select>
        <button type="submit" disabled={sending || busy || !message.trim() || !connection}>
          {sending ? "Starting..." : busy ? "Agent is working…" : followUp ? "Send" : "Make video"}
        </button>
      </div>
      {runtimes.data && usable.length === 0 && (
        <p className="banner banner-warning">
          Add an AI key once to start making videos.{" "}
          <Link to="/settings/models" className="button small">
            Add an AI key
          </Link>
        </p>
      )}
    </form>
  );
}
