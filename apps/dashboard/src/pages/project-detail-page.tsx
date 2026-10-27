import { api } from "../api-client.ts";
import { Empty, ErrorBanner, formatDate, Link, Section, StatusBadge, useAsync } from "../ui.tsx";

export function ProjectDetailPage({ projectId }: { projectId: string }) {
  const { data, error, loading, reload } = useAsync(() => api.project(projectId), [projectId]);
  const playable = data?.renders.filter((r) => r.url) ?? [];

  return (
    <>
      <ErrorBanner error={error} />
      {data && (
        <Section
          title={data.project.title}
          actions={
            <button type="button" className="secondary" onClick={reload} disabled={loading}>
              Refresh
            </button>
          }
        >
          <dl className="facts">
            <dt>Status</dt>
            <dd>
              <StatusBadge status={data.project.status} />
            </dd>
            <dt>Prompt</dt>
            <dd className="prewrap">{data.project.brief.prompt ?? "-"}</dd>
            <dt>Format</dt>
            <dd>{data.project.brief.aspectRatio ?? "default"}</dd>
            <dt>IR version</dt>
            <dd>
              {data.currentVersion ? `v${data.currentVersion.version} (${data.currentVersion.source})` : "-"}
            </dd>
            <dt>Created</dt>
            <dd>{formatDate(data.project.createdAt)}</dd>
          </dl>
        </Section>
      )}
      {playable.length > 0 && (
        <Section title="Videos">
          {playable.map((r) => (
            <figure key={r.id} className="video">
              {/* biome-ignore lint/a11y/useMediaCaption: generated videos have no caption track yet. */}
              <video src={r.url} controls preload="metadata" />
              <figcaption>
                {r.preset} - link expires {formatDate(r.urlExpiresAt)}
              </figcaption>
            </figure>
          ))}
        </Section>
      )}
      {data && (
        <Section title="Jobs">
          {data.jobs.length === 0 ? (
            <Empty>No jobs.</Empty>
          ) : (
            <ul className="list">
              {data.jobs.map((j) => (
                <li key={j.id}>
                  <Link to={`/jobs/${j.id}`}>{j.kind}</Link> <StatusBadge status={j.status} />{" "}
                  <span className="muted">{formatDate(j.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </>
  );
}
