import { useState } from "react";
import { api, type OAuthConnection } from "../api-client.ts";
import { Empty, ErrorBanner, formatDate, Link, Section, useAsync } from "../ui.tsx";

/** OAuth clients (MCP connectors) the user has authorized, per workspace, with revocation. */
export function ConnectedAppsPage() {
  const { data, error, reload } = useAsync(() => api.oauthConnections());
  const [actionError, setActionError] = useState<unknown>();
  const [revoking, setRevoking] = useState<string>();

  async function revoke(connection: OAuthConnection) {
    const prompt = `Revoke access for ${connection.clientName || connection.clientId}? It stops working immediately and must be authorized again.`;
    if (!window.confirm(prompt)) return;
    setActionError(undefined);
    setRevoking(connection.id);
    try {
      await api.revokeOAuthConnection(connection.id);
      reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setRevoking(undefined);
    }
  }

  const connections = data?.items;
  return (
    <Section title="Connected apps">
      <ErrorBanner error={error} />
      <ErrorBanner error={actionError} />
      {connections && connections.length === 0 && (
        <Empty>
          No apps connected yet. Claude, ChatGPT and other connectors that sign in with OAuth appear here once
          you authorize them. For headless use, <Link to="/api-keys">API keys</Link> remain available.
        </Empty>
      )}
      {connections && connections.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>App</th>
              <th>Workspace</th>
              <th>Permissions</th>
              <th>Connected</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {connections.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.clientName || c.clientId}
                  {c.clientUri && <div className="muted mono">{c.clientUri}</div>}
                </td>
                <td>
                  {c.organizationName} / {c.workspaceName}
                </td>
                <td className="mono">{c.scopes.join(" ")}</td>
                <td>{formatDate(c.createdAt)}</td>
                <td>
                  <button
                    type="button"
                    className="danger small"
                    disabled={revoking !== undefined}
                    aria-label={`Revoke ${c.clientName || c.clientId}`}
                    onClick={() => void revoke(c)}
                  >
                    {revoking === c.id ? "Revoking..." : "Revoke"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}
