import { useEffect, useState } from "react";
import { api, type Job } from "../api-client.ts";
import { Empty, ErrorBanner, formatDate, Link, Section, StatusBadge, useAsync } from "../ui.tsx";

const ACTIVE = new Set(["queued", "running", "waiting_approval", "waiting_host"]);
const POLL_MS = 3000;

function durationOf(startedAt?: string, finishedAt?: string): string {
  if (!startedAt) return "";
  const ms = new Date(finishedAt ?? Date.now()).getTime() - new Date(startedAt).getTime();
  return ms >= 0 ? `${(ms / 1000).toFixed(1)}s` : "";
}

function StageTimeline({ job }: { job: Job }) {
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
          {s.error && (
            <p className="banner banner-error">
              {s.error.code}: {s.error.message} {s.error.suggestedAction}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

export function JobDetailPage({ jobId }: { jobId: string }) {
  const { data, error, reload } = useAsync(() => api.job(jobId), [jobId]);
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
            <dt>Budget</dt>
            <dd>
              {job.budget
                ? `${job.budget.spentCents}c spent${job.budget.limitCents !== undefined ? ` of ${job.budget.limitCents}c` : ""}`
                : "-"}
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
          <StageTimeline job={job} />
        </Section>
      )}
      {data && (
        <Section title="Activity">
          {data.activity.length === 0 ? (
            <Empty>No activity recorded.</Empty>
          ) : (
            <ul className="list activity">
              {data.activity.map((a) => (
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
