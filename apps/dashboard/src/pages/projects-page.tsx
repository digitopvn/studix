import { api } from "../api-client.ts";
import { Empty, ErrorBanner, formatDate, Link, Section, StatusBadge, useAsync } from "../ui.tsx";

export function ProjectsPage() {
  const { data, error, loading, reload } = useAsync(() => api.projects());
  return (
    <Section
      title="Projects"
      actions={
        <div className="row">
          <button type="button" className="secondary" onClick={reload} disabled={loading}>
            Refresh
          </button>
          <Link to="/create" className="button">
            New video
          </Link>
        </div>
      }
    >
      <ErrorBanner error={error} />
      {data && data.items.length === 0 && <Empty>No projects yet. Create your first video.</Empty>}
      {data && data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Format</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link to={`/projects/${p.id}`}>{p.title}</Link>
                </td>
                <td>
                  <StatusBadge status={p.status} />
                </td>
                <td>{p.brief.aspectRatio ?? "-"}</td>
                <td>{formatDate(p.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}
