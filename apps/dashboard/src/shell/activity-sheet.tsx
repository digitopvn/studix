import { useEffect, useRef, useState } from "react";
import { api, type Job } from "../api-client.ts";
import { CopyForAgent } from "../copy-for-agent.tsx";
import { errorText, Link, StatusBadge } from "../ui.tsx";

const RUNNING = new Set(["queued", "running", "rendering", "waiting"]);

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
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  async function retry(id: string) {
    setError(undefined);
    try {
      await api.retryJob(id);
      reload();
    } catch (e) {
      setError(errorText(e));
    }
  }

  const groups: Array<[string, Job[]]> = [
    ["Running", jobs.filter((j) => RUNNING.has(j.status))],
    ["Failed", jobs.filter((j) => j.status === "failed")],
    ["Done", jobs.filter((j) => j.status === "succeeded").slice(0, 8)],
  ];
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
      {groups.map(([title, items]) =>
        items.length ? (
          <section key={title} className="sheet-group">
            <h3>{title}</h3>
            {items.map((j) => (
              <div key={j.id} className="activity-row">
                <div className="activity-main">
                  <Link to={jobHref(j)}>{j.kind.replace(/_/g, " ")}</Link>
                  <span className="muted small-text">
                    {j.stage ?? ""} {RUNNING.has(j.status) ? `${Math.round(j.progress * 100)}%` : ""}
                  </span>
                </div>
                <StatusBadge status={j.status} />
                {j.status === "failed" && (
                  <div className="row">
                    <button type="button" className="small" onClick={() => void retry(j.id)}>
                      Retry
                    </button>
                    <Link to="/settings/models" className="button secondary small">
                      Add key
                    </Link>
                    <CopyForAgent tool="studix_get_job" args={{ jobId: j.id }} small />
                  </div>
                )}
              </div>
            ))}
          </section>
        ) : null,
      )}
      {!jobs.length && <p className="muted">Nothing has run yet.</p>}
      <p>
        <Link to="/activity">All activity</Link>
      </p>
    </dialog>
  );
}
