import { type FormEvent, useState } from "react";
import { api } from "../api-client.ts";
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
      <Section title="API keys">
        <p className="muted">
          MCP endpoint: <code>{mcpUrl}</code>. Send the key as <code>Authorization: Bearer &lt;key&gt;</code>.
        </p>
        <form className="row" onSubmit={create}>
          <input
            required
            maxLength={100}
            placeholder="Key name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select value={role} onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}>
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
      <Section title="Existing keys">
        <ErrorBanner error={error} />
        {data && data.items.length === 0 && <Empty>No keys yet.</Empty>}
        {data && data.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Prefix</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last used</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td className="mono">{k.prefix}...</td>
                  <td>{k.role}</td>
                  <td>
                    <StatusBadge status={k.status} />
                  </td>
                  <td>{formatDate(k.lastUsedAt)}</td>
                  <td>{formatDate(k.expiresAt)}</td>
                  <td>
                    {k.status === "active" && (
                      <button type="button" className="danger small" onClick={() => revoke(k.id)}>
                        Revoke
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
