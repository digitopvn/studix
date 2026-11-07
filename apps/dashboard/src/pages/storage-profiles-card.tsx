import { type FormEvent, useState } from "react";
import {
  api,
  type PlatformStorageTest,
  type StorageProfile,
  type StorageProfileInput,
  type StorageProfileScope,
  type StorageProviderType,
} from "../api-client.ts";
import { ErrorBanner, formatDate, Section, StatusBadge } from "../ui.tsx";

const PROVIDER_LABELS: Record<StorageProfile["providerType"], string> = {
  "cloudflare-r2": "Cloudflare R2",
  "aws-s3": "AWS S3",
  "s3-compatible": "S3-compatible",
  environment: "Environment",
  platform: "Platform",
};

const EMPTY: StorageProfileInput = {
  name: "",
  providerType: "cloudflare-r2",
  endpoint: "",
  bucket: "",
  region: "auto",
  forcePathStyle: false,
  keyPrefix: "",
};

/**
 * Storage profiles: where new renders and assets are written. Saving a profile runs a real write, read and
 * delete with the typed settings first and stores nothing when it fails. Activating one switches new
 * objects to it on the app and the worker within seconds; objects already stored stay readable from the
 * profile they were written to. The key pair is typed once and never shown again.
 */
export function StorageProfilesCard({
  profiles,
  reload,
  scope = "platform",
}: {
  profiles: StorageProfile[];
  reload: () => void;
  /** `workspace`: this workspace's own profiles; its active one overrides the platform choice. */
  scope?: StorageProfileScope;
}) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const [editing, setEditing] = useState<{ id?: string; input: StorageProfileInput }>();
  const [tests, setTests] = useState<Record<string, PlatformStorageTest>>({});

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

  const set = (patch: Partial<StorageProfileInput>) =>
    setEditing((current) => current && { ...current, input: { ...current.input, ...patch } });

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const { id, input } = editing;
    const keyGiven = Boolean(input.accessKeyId?.trim() || input.secretAccessKey?.trim());
    const body: StorageProfileInput = {
      ...input,
      ...(input.endpoint?.trim() ? { endpoint: input.endpoint.trim() } : { endpoint: undefined }),
      ...(keyGiven ? {} : { accessKeyId: undefined, secretAccessKey: undefined }),
    };
    // The secret leaves component state as soon as it is sent, whether or not the server accepts it.
    set({ secretAccessKey: "" });
    await act(async () => {
      if (id) await api.updateStorageProfile(id, body, scope);
      else await api.createStorageProfile(body, scope);
      setEditing(undefined);
    });
  }

  const edit = (profile?: StorageProfile) =>
    setEditing(
      profile && profile.providerType !== "environment" && profile.providerType !== "platform"
        ? {
            id: profile.id,
            input: {
              name: profile.name,
              providerType: profile.providerType,
              endpoint: profile.endpointHost ? `https://${profile.endpointHost}` : "",
              bucket: profile.bucket ?? "",
              region: profile.region,
              forcePathStyle: profile.forcePathStyle,
              keyPrefix: profile.keyPrefix,
            },
          }
        : { input: { ...EMPTY } },
    );

  async function activate(profile: StorageProfile) {
    const message =
      profile.id === "env"
        ? scope === "workspace"
          ? "Write this workspace's new objects to the platform storage again? Objects already stored stay readable."
          : "Write new objects with the deployment settings (S3_*) again? Objects already stored stay readable."
        : `Write new objects to "${profile.name}" from now on? Objects already stored stay readable where they are.`;
    if (!window.confirm(message)) return;
    await act(() => api.activateStorageProfile(profile.id, scope));
  }

  async function remove(profile: StorageProfile) {
    if (!window.confirm(`Delete "${profile.name}" and its stored key pair?`)) return;
    await act(() => api.deleteStorageProfile(profile.id, scope));
  }

  async function test(profile: StorageProfile) {
    await act(async () => {
      const result = await api.testStorageProfile(profile.id, scope);
      setTests((t) => ({ ...t, [profile.id]: result }));
    });
  }

  const input = editing?.input;
  return (
    <Section
      title={scope === "workspace" ? "Workspace storage" : "Storage profiles"}
      actions={
        <button type="button" disabled={busy || Boolean(editing)} onClick={() => edit()}>
          Add profile
        </button>
      }
    >
      <p className="muted">
        New files go to the active profile; switching takes about 20 seconds and old files stay readable. A
        profile is saved only after a test write, read and delete pass.
      </p>
      <ErrorBanner error={actionError} />
      {input && (
        <form className="stack" onSubmit={save}>
          <div className="row">
            <input
              required
              aria-label="Profile name"
              placeholder="Name"
              value={input.name}
              disabled={busy}
              onChange={(e) => set({ name: e.target.value })}
            />
            <select
              aria-label="Provider"
              value={input.providerType}
              disabled={busy}
              onChange={(e) => set({ providerType: e.target.value as StorageProviderType })}
            >
              <option value="cloudflare-r2">Cloudflare R2</option>
              <option value="aws-s3">AWS S3</option>
              <option value="s3-compatible">S3-compatible</option>
            </select>
          </div>
          <div className="row">
            <input
              aria-label="Endpoint"
              placeholder={input.providerType === "aws-s3" ? "Endpoint (optional)" : "https://… endpoint"}
              required={input.providerType !== "aws-s3"}
              value={input.endpoint ?? ""}
              disabled={busy}
              onChange={(e) => set({ endpoint: e.target.value })}
            />
            <input
              required
              aria-label="Bucket"
              placeholder="Bucket"
              value={input.bucket}
              disabled={busy}
              onChange={(e) => set({ bucket: e.target.value })}
            />
            <input
              required
              aria-label="Region"
              placeholder="Region (auto for R2)"
              value={input.region}
              disabled={busy}
              onChange={(e) => set({ region: e.target.value })}
            />
          </div>
          <div className="row">
            <input
              aria-label="Key prefix"
              placeholder="Key prefix (optional, ends with /)"
              value={input.keyPrefix ?? ""}
              disabled={busy}
              onChange={(e) => set({ keyPrefix: e.target.value })}
            />
            <label>
              <input
                type="checkbox"
                checked={input.forcePathStyle ?? false}
                disabled={busy}
                onChange={(e) => set({ forcePathStyle: e.target.checked })}
              />{" "}
              Path-style addressing
            </label>
          </div>
          <div className="row">
            <input
              required={!editing?.id}
              autoComplete="off"
              aria-label="Access key ID"
              placeholder={editing?.id ? "Access key ID (blank keeps the stored one)" : "Access key ID"}
              value={input.accessKeyId ?? ""}
              disabled={busy}
              onChange={(e) => set({ accessKeyId: e.target.value })}
            />
            <input
              required={!editing?.id}
              type="password"
              autoComplete="new-password"
              aria-label="Secret access key"
              placeholder={editing?.id ? "Secret access key (blank keeps it)" : "Secret access key"}
              value={input.secretAccessKey ?? ""}
              disabled={busy}
              onChange={(e) => set({ secretAccessKey: e.target.value })}
            />
          </div>
          <div className="row">
            <button type="submit" disabled={busy}>
              {busy ? "Testing…" : "Test and save"}
            </button>
            <button type="button" disabled={busy} onClick={() => setEditing(undefined)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <ul className="key-list">
        {profiles.map((p) => {
          const result = tests[p.id];
          const last = result
            ? { ok: result.ok, at: result.at, detail: result.suggestedAction ?? result.diagnosis }
            : p.lastTest;
          return (
            <li key={p.id} className="key-row">
              <div className="key-main">
                <div className="key-title">
                  <strong>{p.name}</strong>
                  {p.active && <StatusBadge status="available" label="In use" />}
                </div>
                <div className="key-meta">
                  <span>{PROVIDER_LABELS[p.providerType]}</span>
                  {p.references !== undefined && <span>{p.references} files</span>}
                  <span>{last ? `Tested ${formatDate(last.at)}` : "Never tested"}</span>
                </div>
                {last && !last.ok && last.detail && <div className="key-error">{last.detail}</div>}
                <details className="why">
                  <summary>Details</summary>
                  <p className="muted mono">
                    {p.endpointHost ?? "Default endpoint"} · {p.bucket ?? "no bucket set"}
                    {p.keyPrefix ? `/${p.keyPrefix}` : ""} · {p.region}
                    {p.forcePathStyle ? " · path-style" : ""}
                    {p.accessKeyHint ? ` · key ${p.accessKeyHint}` : " · server key"}
                    {p.version ? ` · v${p.version}` : ""}
                  </p>
                </details>
              </div>
              {last ? (
                <StatusBadge status={last.ok ? "available" : "failed"} label={last.ok ? "Works" : "Failed"} />
              ) : (
                <span />
              )}
              <div className="key-actions">
                {(scope === "platform" || p.id !== "env") && (
                  <button type="button" className="secondary small" disabled={busy} onClick={() => test(p)}>
                    Test
                  </button>
                )}
                {!p.active && (
                  <button
                    type="button"
                    className="secondary small"
                    disabled={busy}
                    onClick={() => activate(p)}
                  >
                    Use this
                  </button>
                )}
                {p.id !== "env" && (
                  <button
                    type="button"
                    className="secondary small"
                    disabled={busy || Boolean(editing)}
                    onClick={() => edit(p)}
                  >
                    Edit
                  </button>
                )}
                {p.id !== "env" && !p.active && !p.references && (
                  <button
                    type="button"
                    className="ghost-danger small"
                    disabled={busy}
                    onClick={() => remove(p)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
