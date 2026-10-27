import { type FormEvent, useState } from "react";
import { api } from "../api-client.ts";
import { Empty, ErrorBanner, formatDate, Section, StatusBadge, useAsync } from "../ui.tsx";

/** Workspace MCP connectors: add an upstream MCP URL, test it (tool discovery), disable it. */
export function ConnectorsPage() {
  const { data, error, reload } = useAsync(() => api.connectors());
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [actionError, setActionError] = useState<unknown>();
  const [results, setResults] = useState<Record<string, string>>({});

  async function act(action: () => Promise<unknown>) {
    setActionError(undefined);
    try {
      await action();
      reload();
    } catch (e) {
      setActionError(e);
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    await act(async () => {
      await api.addConnector({ name: name.trim(), url: url.trim() });
      setName("");
      setUrl("");
    });
  }

  async function test(id: string) {
    await act(async () => {
      const result = await api.testConnector(id);
      const summary = result.ok
        ? `OK - ${result.toolCount ?? result.tools?.length ?? 0} tools${result.tools ? `: ${result.tools.join(", ")}` : ""}`
        : `Failed - ${result.error ?? "unknown error"}`;
      setResults((r) => ({ ...r, [id]: summary }));
    });
  }

  return (
    <>
      <Section title="Add connector">
        <form className="row" onSubmit={add}>
          <input
            required
            pattern="[a-z][a-z0-9-]{1,39}"
            title="Lowercase letters, digits and dashes; starts with a letter."
            placeholder="name (e.g. brand-assets)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            required
            type="url"
            placeholder="https://mcp.example.com/mcp"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button type="submit">Add</button>
        </form>
        <ErrorBanner error={actionError} />
      </Section>
      <Section title="Connectors">
        <ErrorBanner error={error} />
        {data && data.items.length === 0 && <Empty>No connectors configured.</Empty>}
        {data && data.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>URL</th>
                <th>Status</th>
                <th>Last check</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="mono">{c.url}</td>
                  <td>
                    <StatusBadge status={c.status} />
                    {c.lastError && <div className="muted">{c.lastError}</div>}
                    {results[c.id] && <div className="muted">{results[c.id]}</div>}
                  </td>
                  <td>{formatDate(c.lastCheckedAt)}</td>
                  <td className="row">
                    <button type="button" className="secondary small" onClick={() => test(c.id)}>
                      Test
                    </button>
                    {c.status !== "disabled" && (
                      <button
                        type="button"
                        className="danger small"
                        onClick={() => act(() => api.disableConnector(c.id))}
                      >
                        Disable
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}
