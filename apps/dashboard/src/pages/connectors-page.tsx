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
    <Section title="Extra tools (MCP connectors)">
      <p className="muted">Give the Studix agent tools from another MCP server, such as your brand assets.</p>
      <ErrorBanner error={error} />
      {data && data.items.length === 0 && <Empty>No connectors yet.</Empty>}
      {data && data.items.length > 0 && (
        <ul className="key-list">
          {data.items.map((c) => (
            <li key={c.id} className="key-row">
              <div className="key-main">
                <div className="key-title">
                  <strong>{c.name}</strong>
                </div>
                <div className="key-meta">
                  <span className="mono">{c.url}</span>
                  <span>{c.lastCheckedAt ? `Checked ${formatDate(c.lastCheckedAt)}` : "Never checked"}</span>
                </div>
                {c.lastError && <div className="key-error">{c.lastError}</div>}
                {results[c.id] && <div className="muted">{results[c.id]}</div>}
              </div>
              <div className="key-state">
                <StatusBadge status={c.status} />
              </div>
              <div className="key-actions">
                <button type="button" className="secondary small" onClick={() => test(c.id)}>
                  Test
                </button>
                {c.status !== "disabled" && (
                  <button
                    type="button"
                    className="ghost-danger small"
                    onClick={() => act(() => api.disableConnector(c.id))}
                  >
                    Disable
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <form className="key-add" onSubmit={add}>
        <input
          required
          pattern="[a-z][a-z0-9-]{1,39}"
          title="Lowercase letters, digits and dashes; starts with a letter."
          aria-label="Connector name"
          placeholder="name (e.g. brand-assets)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          required
          type="url"
          aria-label="Connector URL"
          placeholder="https://mcp.example.com/mcp"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button type="submit">Add</button>
      </form>
      <ErrorBanner error={actionError} />
    </Section>
  );
}
