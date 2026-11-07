import { type FormEvent, useState } from "react";
import { api } from "../api-client.ts";
import { ConnectSetup } from "../shell/connect-dialog.tsx";
import { Empty, ErrorBanner, formatDate, Section, StatusBadge, useAsync } from "../ui.tsx";

const ROLES = ["viewer", "editor", "admin"] as const;

/** Create (secret shown exactly once), list and revoke workspace API keys for MCP clients. */
export function ApiKeysPage({ mcpUrl }: { mcpUrl: string }) {
  const { data, error, reload } = useAsync(() => api.apiKeys());
  const [name, setName] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("editor");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [secret, setSecret] = useState<string>();
  const [actionError, setActionError] = useState<unknown>();

  async function create(event: FormEvent) {
    event.preventDefault();
    setActionError(undefined);
    const days = Number(expiresInDays);
    try {
      const created = await api.createApiKey({
        name: name.trim(),
        role,
        expiresAt: days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : undefined,
      });
      setSecret(created.secret);
      setName("");
      reload();
    } catch (e) {
      setActionError(e);
    }
  }

  async function revoke(id: string) {
    if (!window.confirm("Revoke this key? Clients using it stop working immediately.")) return;
    setActionError(undefined);
    try {
      await api.revokeApiKey(id);
      reload();
    } catch (e) {
      setActionError(e);
    }
  }

  return (
    <>
      <Section title="Connect your agent">
        <p className="muted">Every action in Studix is also a tool your agent can call over MCP.</p>
        <ConnectSetup mcpUrl={mcpUrl} />
      </Section>
      <Section title="API keys">
        <p className="muted">For scripts, CI and clients without sign-in. Apps that sign in need no key.</p>
        <ErrorBanner error={error} />
        {data && data.items.length === 0 && <Empty>No keys yet.</Empty>}
        {data && data.items.length > 0 && (
          <ul className="key-list">
            {data.items.map((k) => (
              <li key={k.id} className="key-row">
                <div className="key-main">
                  <div className="key-title">
                    <strong>{k.name}</strong>
                  </div>
                  <div className="key-meta">
                    <span className="mono">{k.prefix}…</span>
                    <span>{k.role}</span>
                    <span>{k.lastUsedAt ? `Used ${formatDate(k.lastUsedAt)}` : "Never used"}</span>
                    {k.expiresAt && <span>Expires {formatDate(k.expiresAt)}</span>}
                  </div>
                </div>
                <div className="key-state">
                  <StatusBadge status={k.status} />
                </div>
                <div className="key-actions">
                  {k.status === "active" && (
                    <button type="button" className="ghost-danger small" onClick={() => revoke(k.id)}>
                      Revoke
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <form className="key-add" onSubmit={create}>
          <input
            required
            maxLength={100}
            aria-label="Key name"
            placeholder="Key name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select
            aria-label="Role"
            value={role}
            onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            max={365}
            aria-label="Expires in days"
            placeholder="Expires in days (optional)"
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
          />
          <button type="submit">Create key</button>
        </form>
        {secret && (
          <div className="banner banner-success">
            <p>Copy this key now. It will not be shown again.</p>
            <code className="secret">{secret}</code>
            <div className="row">
              <button
                type="button"
                className="secondary"
                onClick={() => void navigator.clipboard?.writeText(secret)}
              >
                Copy
              </button>
              <button type="button" className="secondary" onClick={() => setSecret(undefined)}>
                Done
              </button>
            </div>
          </div>
        )}
        <ErrorBanner error={actionError} />
      </Section>
    </>
  );
}
