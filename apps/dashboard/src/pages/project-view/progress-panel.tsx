import { useState } from "react";
import type { ProjectReview } from "../../api-client.ts";
import { jobTitle } from "../../shell/job-labels.ts";
import { formatDate, Link, StatusBadge } from "../../ui.tsx";
import { BlockView, useAgentRun } from "../agent-chat-page.tsx";

const PAGE = 8;
const LIVE = new Set(["queued", "running", "rendering", "waiting", "waiting_approval"]);

type ProjectJob = ProjectReview["cost"]["jobs"][number];

/**
 * The project's runs, newest first. A run streams its agent steps only while expanded, and shows the newest
 * steps first, a page at a time.
 */
export function ProgressPanel({ jobs }: { jobs: ProjectJob[] }) {
  const sorted = [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!sorted.length) return null;
  return (
    <section className="pv-progress">
      <h2>Progress</h2>
      {sorted.map((j, i) => (
        <RunItem key={j.id} job={j} defaultOpen={i === 0} />
      ))}
    </section>
  );
}

function RunItem({ job, defaultOpen }: { job: ProjectJob; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details className="pv-run" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="pv-run-title">{jobTitle(job)}</span>
        <StatusBadge status={job.status} />
        <span className="muted small-text">{formatDate(job.createdAt)}</span>
      </summary>
      {open && <RunSteps job={job} />}
    </details>
  );
}

function RunSteps({ job }: { job: ProjectJob }) {
  const { run } = useAgentRun(job.id);
  const [shown, setShown] = useState(PAGE);
  const steps = [...run.blocks].reverse();
  const live = LIVE.has(job.status);
  return (
    <div className="pv-run-steps">
      {live && <div className="chat-typing" role="status" aria-label="Agent is working" />}
      {steps.length === 0 && (
        <p className="muted small-text">{live ? "Waiting for the agent…" : "No steps."}</p>
      )}
      {steps.slice(0, shown).map((block, i) => (
        <BlockView
          key={block.kind === "tool" ? block.id : `${block.kind}-${steps.length - i}`}
          block={block}
        />
      ))}
      {steps.length > shown && (
        <button type="button" className="ghost small" onClick={() => setShown((n) => n + PAGE)}>
          Show {Math.min(PAGE, steps.length - shown)} earlier
        </button>
      )}
      <Link to={`/chat/${job.id}`} className="small-text">
        Open full run
      </Link>
    </div>
  );
}
