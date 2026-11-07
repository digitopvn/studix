import { type FormEvent, useState } from "react";
import { api, type WorkspaceMediaKey } from "../api-client.ts";
import { ErrorBanner, formatDate, Section, StatusBadge, useAsync } from "../ui.tsx";

const VENDOR_NAMES: Record<string, string> = {
  sume: "Sume",
  atlas: "Atlas Cloud",
  elevenlabs: "ElevenLabs",
  fish: "Fish Audio",
  minimax: "MiniMax",
  openrouter: "OpenRouter",
};

/**
 * The workspace's own media vendor keys (BYOK). A stored key replaces the platform key for this workspace's
 * media calls only, and that spend is recorded as paid by the workspace. Keys are sent once and never shown.
 */
export function WorkspaceMediaKeysSection() {
  const { data, error, reload } = useAsync(() => api.workspaceMediaKeys());
  return (
    <Section title="Media vendor keys · Bring your own key">
      <ErrorBanner error={error} />
      <p className="muted">
        Without a key here, media jobs use the platform key. A workspace key is used only for this workspace's
        jobs; its spend is recorded but not charged by Studix.
      </p>
      {data?.storage === "unavailable" && (
        <p className="muted">Encrypted key storage is not configured on this server (STUDIX_SECRETS_KEY).</p>
      )}
      {data && (
        <table>
          <thead>
            <tr>
              <th>Vendor</th>
              <th>Key</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.keys.map((key) => (
              <MediaKeyRow key={key.vendor} mediaKey={key} canManage={data.canManage} reload={reload} />
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function MediaKeyRow({
  mediaKey,
  canManage,
  reload,
}: {
  mediaKey: WorkspaceMediaKey;
  canManage: boolean;
  reload: () => void;
}) {
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const name = VENDOR_NAMES[mediaKey.vendor] ?? mediaKey.vendor;
  const own = mediaKey.source === "workspace";

  async function act(action: () => Promise<unknown>) {
    setActionError(undefined);
    setBusy(true);
    try {
      await action();
      reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const key = value.trim();
    // The secret leaves component state as soon as it is sent, whether or not the server accepts it.
    setValue("");
    await act(async () => {
      await api.setWorkspaceMediaKey(mediaKey.vendor, key);
      setEditing(false);
    });
  }

  async function remove() {
    if (
      !window.confirm(
        `Remove this workspace's ${name} key? Media jobs go back to the platform key. The key is not revoked at ${name}.`,
      )
    ) {
      return;
    }
    await act(() => api.removeWorkspaceMediaKey(mediaKey.vendor));
  }

  return (
    <tr>
      <td>
        {name}
        <ErrorBanner error={actionError} />
        {editing && (
          <form className="row" onSubmit={save}>
            <input
              required
              type="password"
              autoComplete="new-password"
              aria-label={`${name} key`}
              placeholder="Paste the key"
              value={value}
              disabled={busy}
              onChange={(e) => setValue(e.target.value)}
            />
            <button type="submit" disabled={busy}>
              Save
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setValue("");
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </form>
        )}
      </td>
      <td>
        <StatusBadge status={own ? "configured" : "missing"} label={own ? "Workspace key" : "Platform key"} />
        {mediaKey.keyHint && <div className="mono muted">{mediaKey.keyHint}</div>}
      </td>
      <td>{mediaKey.updatedAt ? formatDate(mediaKey.updatedAt) : "-"}</td>
      <td>
        {canManage && !editing && (
          <button type="button" disabled={busy} onClick={() => setEditing(true)}>
            {own ? "Rotate" : "Add key"}
          </button>
        )}{" "}
        {canManage && own && (
          <button type="button" disabled={busy} onClick={remove}>
            Remove
          </button>
        )}
      </td>
    </tr>
  );
}
