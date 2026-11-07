import { useState } from "react";
import { api, type OAuthConnection } from "../api-client.ts";
import { Empty, ErrorBanner, formatDate, Section, useAsync } from "../ui.tsx";

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
        <Empty>No apps yet. Claude, ChatGPT and Cursor show up here after you sign in from them.</Empty>
      )}
      {connections && connections.length > 0 && (
        <ul className="key-list">
          {connections.map((c) => (
            <li key={c.id} className="key-row">
              <div className="key-main">
                <div className="key-title">
                  <strong>{c.clientName || c.clientId}</strong>
                </div>
                <div className="key-meta">
                  <span>
                    {c.organizationName} / {c.workspaceName}
                  </span>
                  <span>Connected {formatDate(c.createdAt)}</span>
                  <span className="mono">{c.scopes.join(" ")}</span>
                </div>
              </div>
              <div className="key-actions">
                <button
                  type="button"
                  className="ghost-danger small"
                  disabled={revoking !== undefined}
                  aria-label={`Revoke ${c.clientName || c.clientId}`}
                  onClick={() => void revoke(c)}
                >
                  {revoking === c.id ? "Revoking..." : "Revoke"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
