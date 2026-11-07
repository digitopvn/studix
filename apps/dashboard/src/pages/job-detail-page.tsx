import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AgentChatEvent,
  type AgentStreamMessage,
  api,
  type Job,
  type JobAgent,
  type Stage,
} from "../api-client.ts";
import { Empty, ErrorBanner, formatDate, Link, Section, StatusBadge, useAsync } from "../ui.tsx";
import { BlockView, FINAL, useAgentRun } from "./agent-chat-page.tsx";
import { formatCents, formatJobAgent, formatStageRuntime, formatStageSpend } from "./job-agent.ts";

const ACTIVE = new Set(["queued", "running", "waiting_approval", "waiting_host"]);
const POLL_MS = 3000;
/** Agent run events render as the chat does, not as raw activity rows. */
const AGENT_EVENT = "agent.event";

/** The job's agent steps with the chat's own blocks: messages, reasoning, tool cards. Oldest first, follows the tail. */
function AgentRunLog({ jobId, agentRun }: { jobId: string; agentRun: ReturnType<typeof useAgentRun> }) {
  const { run, job } = agentRun;
  const end = useRef<HTMLDivElement>(null);
  const count = run.blocks.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll again whenever a block arrives.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [count]);
  if (count === 0) return null;
  return (
    <div className="chat-agent job-agent-log">
      <div className="chat-meta">
        <strong>Agent run</strong>
        <Link to={`/chat/${jobId}`}>Open as chat</Link>
      </div>
      {run.blocks.map((block, i) => (
        <BlockView key={block.kind === "tool" ? block.id : `${block.kind}-${i}`} block={block} />
      ))}
      {job && !FINAL.has(job.status) && (
        <div className="chat-typing" role="status" aria-label="Agent is working" />
      )}
      <div ref={end} />
    </div>
  );
}

function BudgetLine({
  spentCents,
  liveCents,
  limitCents,
}: {
  spentCents: number;
  liveCents: number;
  limitCents?: number;
}) {
  const limit = limitCents !== undefined ? ` of ${limitCents}c` : "";
  if (liveCents <= 0) return <>{`${formatCents(spentCents)} spent${limit}`}</>;
  return (
    <>
      {`${formatCents(spentCents + liveCents)} spent${limit}`}{" "}
      <span className="muted">(includes {formatCents(liveCents)} live from the running stage)</span>
    </>
  );
}

function durationOf(startedAt?: string, finishedAt?: string): string {
  if (!startedAt) return "";
  const ms = new Date(finishedAt ?? Date.now()).getTime() - new Date(startedAt).getTime();
  return ms >= 0 ? `${(ms / 1000).toFixed(1)}s` : "";
}

type UsageEvent = Extract<AgentChatEvent, { type: "usage" }>;
type StatusEvent = Extract<AgentChatEvent, { type: "status" }>;

/** The latest usage and status the agent stream reported per stage: a running stage books its cost only at the end. */
interface LiveStage {
  usage?: UsageEvent;
  status?: StatusEvent;
}

function useLiveStages(): [Record<string, LiveStage>, (message: AgentStreamMessage) => void] {
  const [live, setLive] = useState<Record<string, LiveStage>>({});
  const onMessage = useCallback((message: AgentStreamMessage) => {
    if (message.kind !== "agent") return;
    const { event } = message;
    const stage = event.stage;
    if (!stage || (event.type !== "usage" && event.type !== "status")) return;
    setLive((prev) => ({
      ...prev,
      [stage]: { ...prev[stage], ...(event.type === "usage" ? { usage: event } : { status: event }) },
    }));
  }, []);
  return [live, onMessage];
}

/** Live cost of the stages that run now and have booked nothing yet. */
function liveCents(stages: readonly Stage[], live: Record<string, LiveStage>): number {
  return stages
    .filter((s) => s.status === "running" && !s.run)
    .reduce((sum, s) => sum + (live[s.name]?.usage?.costCents ?? 0), 0);
}

/** The effort a run used: its own, else the job's agent effort when that agent is the runtime (the live stream and
 * runs recorded before the effort was stored name none). */
function effortOf(runtime: string, effort: string | undefined, agent: JobAgent | undefined) {
  const shown = effort ?? (agent?.runtime === runtime ? agent.reasoningEffort : undefined);
  return shown ? { reasoningEffort: shown } : {};
}

function StageRunLine({ stage, live, agent }: { stage: Stage; live?: LiveStage; agent?: JobAgent }) {
  if (stage.run) {
    return (
      <div className="row muted">
        <span>
          {formatStageRuntime({
            ...stage.run,
            ...effortOf(stage.run.runtime, stage.run.reasoningEffort, agent),
          })}
        </span>
        <span>{formatStageSpend(stage.run)}</span>
      </div>
    );
  }
  if (stage.status !== "running" || !live?.status) return null;
  const usage = live.usage;
  return (
    <div className="row muted">
      <span>
        {formatStageRuntime({
          runtime: live.status.runtime,
          model: usage?.model ?? live.status.model,
          ...effortOf(live.status.runtime, undefined, agent),
        })}
      </span>
      {usage && (
        <span>
          {formatStageSpend(usage)} <span className="badge">live</span>
        </span>
      )}
    </div>
  );
}

/** The QA role's verdict per round: overall and per-criterion scores (0-10) and the notes sent back. */
function QaRounds({ rounds }: { rounds: NonNullable<Stage["review"]>["rounds"] }) {
  return (
    <ol>
      {rounds.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rounds never reorder.
        <li key={i}>
          <div className="row">
            <span className="muted">QA round {i + 1}</span>
            <span className={`badge ${r.verdict === "pass" ? "badge-succeeded" : ""}`}>{r.verdict}</span>
            <strong>{r.overall}/10</strong>
            {Object.entries(r.scores).map(([k, v]) => (
              <span key={k} className="muted">
                {k} {v}
              </span>
            ))}
          </div>
          {r.notes && <p className="muted">{r.notes}</p>}
        </li>
      ))}
    </ol>
  );
}

function StageTimeline({ job, live }: { job: Job; live: Record<string, LiveStage> }) {
  const stages = job.stages ?? [];
  if (stages.length === 0) return <Empty>No stages started yet.</Empty>;
  return (
    <ol className="timeline">
      {stages.map((s) => (
        <li key={`${s.name}-${s.attempt}`} className={`timeline-item timeline-${s.status}`}>
          <div className="row">
            <strong>{s.name}</strong>
            <StatusBadge status={s.status} />
            {s.attempt > 1 && <span className="muted">attempt {s.attempt}</span>}
            <span className="muted">{durationOf(s.startedAt, s.finishedAt)}</span>
          </div>
          <StageRunLine stage={s} live={live[s.name]} agent={job.agent} />
          {s.error && (
            <p className="banner banner-error">
              {s.error.code}: {s.error.message} {s.error.suggestedAction}
            </p>
          )}
          {s.review && <QaRounds rounds={s.review.rounds} />}
          {s.fallback && (
            <p className="banner banner-warning">Agent did not run, used the template: {s.fallback}</p>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Send a creative gate back: the asset ids to redo and what to change; the job redoes them and asks again. */
function RequestChanges({
  approvalId,
  onSubmit,
}: {
  approvalId: string;
  onSubmit: (run: () => Promise<unknown>) => void;
}) {
  const [targets, setTargets] = useState("");
  const [note, setNote] = useState("");
  const ids = targets
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(() =>
          api.decideApproval(approvalId, "changes_requested", { targets: ids, comment: note.trim() }),
        );
      }}
    >
      <label>
        Asset ids to redo
        <input value={targets} onChange={(e) => setTargets(e.target.value)} placeholder="mai-sheet-v1" />
      </label>
      <label>
        What to change
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} />
      </label>
      <button type="submit" disabled={ids.length === 0 || note.trim().length === 0}>
        Request changes
      </button>
    </form>
  );
}

export function JobDetailPage({ jobId }: { jobId: string }) {
  const { data, error, reload } = useAsync(() => api.job(jobId), [jobId]);
  const [live, onAgentMessage] = useLiveStages();
  const agentRun = useAgentRun(jobId, onAgentMessage);
  const [actionError, setActionError] = useState<unknown>();
  const job = data?.job;
  const active = job ? ACTIVE.has(job.status) : false;
  // A publish is not idempotent, so the server refuses to resume it; do not offer a button that always fails.
  const retryable = job ? job.status === "failed" && job.kind !== "video.publish" : false;

  // Poll while the job is still moving; stop once it reaches a terminal state.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [active, reload]);

  async function act(action: () => Promise<unknown>) {
    setActionError(undefined);
    try {
      await action();
      reload();
    } catch (e) {
      setActionError(e);
    }
  }

  return (
    <>
      <ErrorBanner error={error} />
      <ErrorBanner error={actionError} />
      {job && (
        <Section
          title={`Job ${job.kind}`}
          actions={
            (active && (
              <button type="button" className="danger" onClick={() => act(() => api.cancelJob(job.id))}>
                Cancel job
              </button>
            )) ||
            (retryable && (
              <button type="button" onClick={() => act(() => api.retryJob(job.id))}>
                Retry job
              </button>
            ))
          }
        >
          <dl className="facts">
            <dt>Status</dt>
            <dd>
              <StatusBadge status={job.status} /> {job.stage && <span className="muted">at {job.stage}</span>}
            </dd>
            <dt>Progress</dt>
            <dd>
              <progress max={1} value={job.progress} /> {Math.round(job.progress * 100)}%
            </dd>
            <dt>Project</dt>
            <dd>{job.projectId ? <Link to={`/projects/${job.projectId}`}>{job.projectId}</Link> : "-"}</dd>
            <dt>Agent</dt>
            <dd>{formatJobAgent(job.agent)}</dd>
            <dt>Budget</dt>
            <dd>
              {job.budget ? (
                <BudgetLine
                  spentCents={job.budget.spentCents}
                  liveCents={liveCents(job.stages ?? [], live)}
                  limitCents={job.budget.limitCents}
                />
              ) : (
                "-"
              )}
            </dd>
            <dt>Created</dt>
            <dd>{formatDate(job.createdAt)}</dd>
          </dl>
          {job.error && (
            <p className="banner banner-error">
              {job.error.code}: {job.error.message} {job.error.suggestedAction}
            </p>
          )}
          {job.approval && job.approval.status === "pending" && (
            <div className="banner">
              <p>Approval required: {job.approval.reason}</p>
              <div className="row">
                <button
                  type="button"
                  onClick={() => act(() => api.decideApproval(job.approval!.id, "approved"))}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => act(() => api.decideApproval(job.approval!.id, "rejected"))}
                >
                  Reject
                </button>
              </div>
              {job.approval.action === "creative.gate" && (
                <RequestChanges approvalId={job.approval.id} onSubmit={act} />
              )}
            </div>
          )}
        </Section>
      )}
      {job?.video && (
        <Section title="Video">
          <figure className="video">
            {/* biome-ignore lint/a11y/useMediaCaption: generated videos have no caption track yet. */}
            <video src={job.video.url} controls preload="metadata" />
            <figcaption>
              {job.video.preset} - link expires {formatDate(job.video.expiresAt)}{" "}
              <a href={job.video.url} download>
                Download MP4
              </a>
            </figcaption>
          </figure>
        </Section>
      )}
      {job?.videoUnavailableReason && <p className="banner">{job.videoUnavailableReason}</p>}
      {job && (
        <Section title="Stages">
          <StageTimeline job={job} live={live} />
        </Section>
      )}
      {data && (
        <Section title="Activity">
          <AgentRunLog jobId={jobId} agentRun={agentRun} />
          {data.activity.filter((a) => a.name !== AGENT_EVENT).length === 0 ? (
            <Empty>No activity recorded.</Empty>
          ) : (
            <ul className="list activity">
              {data.activity
                .filter((a) => a.name !== AGENT_EVENT)
                .map((a) => (
                  <li key={a.id} className={`level-${a.level}`}>
                    <span className="muted">{formatDate(a.createdAt)}</span> <code>{a.name}</code>
                    {a.stage && <span className="muted"> [{a.stage}]</span>}
                    {a.message && <span> {a.message}</span>}
                    {a.durationMs !== undefined && <span className="muted"> ({a.durationMs}ms)</span>}
                  </li>
                ))}
            </ul>
          )}
        </Section>
      )}
    </>
  );
}
