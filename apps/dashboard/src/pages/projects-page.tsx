import { type CSSProperties, useState } from "react";
import { api } from "../api-client.ts";
import { ErrorBanner, formatDate, Link, StatusBadge, useAsync } from "../ui.tsx";
import { ProjectThumbnail } from "./project-thumbnail.tsx";
import "./projects.css";

const FILTERS = [
  { id: "all", label: "All", match: () => true },
  { id: "running", label: "Running", match: (s: string) => /queued|running|render|planning|draft/.test(s) },
  { id: "review", label: "Ready to review", match: (s: string) => /review|awaiting|storyboard/.test(s) },
  { id: "failed", label: "Failed", match: (s: string) => /fail|error/.test(s) },
] as const;

/** A stable hue per project, so each card frame is recognizable before a poster exists. */
function hue(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  // Spread neighbouring ids (same prefix, last character differs) far apart on the colour wheel.
  return (h * 137) % 360;
}

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  planning: "Planning",
  rendering: "Rendering",
  in_review: "Ready to review",
  approved: "Approved",
  published: "Published",
  failed: "Failed",
  archived: "Archived",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, " ");
}

export function ProjectsPage() {
  const { data, error } = useAsync(() => api.projects());
  const [filter, setFilter] = useState<string>("all");
  const [q, setQ] = useState("");
  const match = FILTERS.find((f) => f.id === filter)?.match ?? (() => true);
  const needle = q.trim().toLowerCase();
  const items = (data?.items ?? []).filter(
    (p) =>
      match(p.status) &&
      (!needle || p.title.toLowerCase().includes(needle) || p.brief.prompt?.toLowerCase().includes(needle)),
  );
  return (
    <div className="projects">
      <header className="page-head">
        <h1>Projects</h1>
        <div className="row">
          <div className="segment" role="tablist" aria-label="Filter">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={filter === f.id}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <input
            type="search"
            placeholder="Search projects"
            aria-label="Search projects"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </header>
      <ErrorBanner error={error} />
      <div className="project-grid">
        <Link to="/" className="project-card new-card">
          <span className="plus">+</span>
          New video
        </Link>
        {items.map((p) => (
          <Link key={p.id} to={`/projects/${p.id}`} className="project-card">
            <span className="poster" style={{ "--h": hue(p.id) } as CSSProperties}>
              <span className="poster-initial" aria-hidden="true">
                {(p.title.trim() || "U").charAt(0).toUpperCase()}
              </span>
              <ProjectThumbnail projectId={p.id} />
              <span className="poster-format">
                {p.brief.aspectRatio ?? "16:9"}
                {p.brief.durationMs ? ` · ${Math.round(p.brief.durationMs / 1000)} s` : ""}
              </span>
            </span>
            <span className="card-meta">
              <strong title={p.title}>{p.title.trim() || "Untitled video"}</strong>
              <span className="row">
                <StatusBadge status={p.status} label={statusLabel(p.status)} />
                <span className="muted small-text">{formatDate(p.updatedAt)}</span>
              </span>
            </span>
          </Link>
        ))}
      </div>
      {data && !items.length && (
        <p className="muted">
          {data.items.length ? "No project matches this filter." : "No projects yet. Make your first video."}
        </p>
      )}
    </div>
  );
}
