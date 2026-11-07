import { useEffect, useRef, useState } from "react";
import { api, type Job } from "../api-client.ts";
import { CopyForAgent } from "../copy-for-agent.tsx";
import { errorText, formatDate, Link } from "../ui.tsx";
import { jobTitle, needsKey, shortError, stepLabel } from "./job-labels.ts";

const RUNNING = new Set(["queued", "running", "rendering", "waiting"]);

const FAILED_PREVIEW = 3;

function jobHref(job: Job): string {
  return job.projectId ? `/projects/${job.projectId}` : `/jobs/${job.id}`;
}

/** Recent runs, polled while the page is open; the pill counts the running ones. */
export function useRecentJobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the manual reload trigger.
  useEffect(() => {
    let active = true;
    const load = () =>
      api.jobs().then(
        (page) => active && setJobs(page.items),
        () => undefined,
      );
    void load();
    const timer = setInterval(load, 10_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [tick]);
  return { jobs, running: jobs.filter((j) => RUNNING.has(j.status)), reload: () => setTick((t) => t + 1) };
}

export function ActivitySheet({
  open,
  onClose,
  jobs,
  reload,
}: {
  open: boolean;
  onClose: () => void;
  jobs: Job[];
  reload: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string>();
  const [showAllFailed, setShowAllFailed] = useState(false);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // A backdrop click targets the dialog too, so close only when it falls outside the sheet's box.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onClick = (e: MouseEvent) => {
      if (e.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
        dialog.close();
    };
    dialog.addEventListener("click", onClick);
    return () => dialog.removeEventListener("click", onClick);
  }, []);

  async function retry(id: string) {
    setError(undefined);
    try {
      await api.retryJob(id);
      reload();
    } catch (e) {
      setError(errorText(e));
    }
  }

  const running = jobs.filter((j) => RUNNING.has(j.status));
  const failed = jobs.filter((j) => j.status === "failed");
  const done = jobs.filter((j) => j.status === "succeeded").slice(0, 5);
  const shownFailed = showAllFailed ? failed : failed.slice(0, FAILED_PREVIEW);
  return (
    <dialog ref={ref} className="sheet" onClose={onClose} aria-label="Activity">
      <header className="sheet-head">
        <h2>Activity</h2>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>
      {error && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}
      {running.length > 0 && (
        <section className="sheet-group">
          <h3>Running · {running.length}</h3>
          {running.map((j) => (
            <Link key={j.id} to={jobHref(j)} className="activity-row">
              <span className="activity-title">{jobTitle(j)}</span>
              <span className="activity-meta">
                {stepLabel(j)} · {Math.round(j.progress * 100)}%
              </span>
              <span className="activity-progress" aria-hidden="true">
                <span style={{ width: `${Math.max(3, Math.round(j.progress * 100))}%` }} />
              </span>
            </Link>
          ))}
        </section>
      )}
      {failed.length > 0 && (
        <section className="sheet-group">
          <h3>Failed · {failed.length}</h3>
          {shownFailed.map((j) => (
            <div key={j.id} className="activity-row failed">
              <Link to={jobHref(j)} className="activity-title">
                {jobTitle(j)}
              </Link>
              <span className="activity-meta">
                Stopped at {stepLabel(j).toLowerCase()} · {formatDate(j.finishedAt ?? j.updatedAt)}
              </span>
              {j.error?.message && <span className="activity-error">{shortError(j.error.message)}</span>}
              <div className="activity-actions">
                {needsKey(j) ? (
                  <Link to="/settings/models" className="button small">
                    Add key
                  </Link>
                ) : (
                  <button type="button" className="small" onClick={() => void retry(j.id)}>
                    Retry
                  </button>
                )}
                {needsKey(j) && (
                  <button type="button" className="secondary small" onClick={() => void retry(j.id)}>
                    Retry
                  </button>
                )}
                <CopyForAgent tool="studix_get_job" args={{ jobId: j.id }} small label="Copy for agent" />
              </div>
            </div>
          ))}
          {failed.length > FAILED_PREVIEW && (
            <button type="button" className="ghost small" onClick={() => setShowAllFailed((v) => !v)}>
              {showAllFailed ? "Show fewer" : `Show ${failed.length - FAILED_PREVIEW} more`}
            </button>
          )}
        </section>
      )}
      {done.length > 0 && (
        <section className="sheet-group">
          <h3>Done</h3>
          {done.map((j) => (
            <Link key={j.id} to={jobHref(j)} className="activity-row">
              <span className="activity-title">{jobTitle(j)}</span>
              <span className="activity-meta">{formatDate(j.finishedAt ?? j.updatedAt)}</span>
            </Link>
          ))}
        </section>
      )}
      {!jobs.length && <p className="muted">Nothing has run yet.</p>}
      <p>
        <Link to="/activity">All activity</Link>
      </p>
    </dialog>
  );
}
