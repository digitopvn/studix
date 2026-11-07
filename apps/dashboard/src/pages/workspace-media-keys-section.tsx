import { type FormEvent, useState } from "react";
import { api, type WorkspaceMediaKey, type WorkspaceMediaKeyTest } from "../api-client.ts";
import { ErrorBanner, formatDate, Section, StatusBadge, useAsync } from "../ui.tsx";

export const KEY_VERDICT: Record<WorkspaceMediaKeyTest["verdict"], string> = {
  available: "Key accepted",
  invalid: "Key rejected",
  unverified: "Not verified",
};

/**
 * The workspace's own media vendor keys (BYOK). A stored key replaces the platform key for this workspace's
 * media calls only, and that spend is recorded as paid by the workspace. Keys are sent once and never shown.
 */
/** "Cloudflare Workers AI (CLOUDFLARE_API_TOKEN)" -> "Cloudflare Workers AI API token": no env-var names. */
export function vendorName(name: string): string {
  const env = /\s*\(([A-Z0-9_]+)\)$/.exec(name);
  if (!env?.[1]) return name;
  const part = env[1]
    .split("_")
    .slice(1)
    .join(" ")
    .toLowerCase()
    .replace(/\bid\b/, "ID")
    .replace(/\bapi\b/, "API");
  return `${name.slice(0, env.index)} ${part}`.trim();
}

export function WorkspaceMediaKeysSection() {
  const { data, error, reload } = useAsync(() => api.workspaceMediaKeys());
  return (
    <Section title="Media vendor keys">
      <ErrorBanner error={error} />
      <p className="muted">
        Studix pays for media by default. Add your own vendor key to bill this workspace's media to your
        account instead.
      </p>
      {data?.storage === "unavailable" && (
        <p className="muted">Key storage is not set up on this server yet. Ask your admin.</p>
      )}
      {data && (
        <ul className="key-list">
          {data.keys.map((key) => (
            <MediaKeyRow key={key.vendor} mediaKey={key} canManage={data.canManage} reload={reload} />
          ))}
        </ul>
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
  const [keyTest, setKeyTest] = useState<WorkspaceMediaKeyTest>();
  const name = vendorName(mediaKey.name ?? mediaKey.vendor);
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
        `Remove this workspace's ${name} key? Studix pays for its media again. The key is not revoked at ${name}.`,
      )
    ) {
      return;
    }
    await act(() => api.removeWorkspaceMediaKey(mediaKey.vendor));
  }

  return (
    <li className="key-row">
      <div className="key-main">
        <strong>{name}</strong>
        <div className="key-meta">
          {mediaKey.keyHint && <span className="mono">{mediaKey.keyHint}</span>}
          {mediaKey.updatedAt && <span>Updated {formatDate(mediaKey.updatedAt)}</span>}
        </div>
        {keyTest && (
          <div className="muted" role="status">
            {KEY_VERDICT[keyTest.verdict]}
            {keyTest.note ? `: ${keyTest.note}` : ""}
          </div>
        )}
        <ErrorBanner error={actionError} />
        {editing && (
          <form className="key-replace" onSubmit={save}>
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
            <button type="submit" className="small" disabled={busy}>
              Save
            </button>
            <button
              type="button"
              className="secondary small"
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
      </div>
      <StatusBadge status={own ? "configured" : "platform"} label={own ? "Your key" : "Billed by Studix"} />
      {canManage && !editing && (
        <div className="key-actions">
          <button type="button" className="secondary small" disabled={busy} onClick={() => setEditing(true)}>
            {own ? "Replace" : "Use my key"}
          </button>
          {own && mediaKey.testable && (
            <button
              type="button"
              className="secondary small"
              disabled={busy}
              title="A free account check at the vendor; nothing is billed"
              onClick={() => act(async () => setKeyTest(await api.testWorkspaceMediaKey(mediaKey.vendor)))}
            >
              Test
            </button>
          )}
          {own && (
            <button type="button" className="ghost-danger small" disabled={busy} onClick={remove}>
              Remove
            </button>
          )}
        </div>
      )}
    </li>
  );
}
