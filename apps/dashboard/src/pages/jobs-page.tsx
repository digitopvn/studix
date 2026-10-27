import { api } from "../api-client.ts";
import { Empty, ErrorBanner, formatDate, Link, Section, StatusBadge, useAsync } from "../ui.tsx";

export function JobsPage() {
  const { data, error, loading, reload } = useAsync(() => api.jobs());
  return (
    <Section
      title="Jobs"
      actions={
        <button type="button" className="secondary" onClick={reload} disabled={loading}>
          Refresh
        </button>
      }
    >
      <ErrorBanner error={error} />
      {data && data.items.length === 0 && <Empty>No jobs yet.</Empty>}
      {data && data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Status</th>
              <th>Stage</th>
              <th>Progress</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((j) => (
              <tr key={j.id}>
                <td>
                  <Link to={`/jobs/${j.id}`}>{j.kind}</Link>
                  <div className="muted mono">{j.id}</div>
                </td>
                <td>
                  <StatusBadge status={j.status} />
                </td>
                <td>{j.stage ?? "-"}</td>
                <td>{Math.round((j.progress ?? 0) * 100)}%</td>
                <td>{formatDate(j.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}
