import { type FormEvent, useEffect, useState } from "react";
import { api, type WorkspaceMultixCheck, type WorkspaceMultixSettings } from "../api-client.ts";
import { ErrorBanner, formatDate, Section, StatusBadge, useAsync } from "../ui.tsx";

const ROLE_LABELS: Record<string, string> = {
  image: "Image",
  video: "Video",
  lipsync: "Lip-sync",
  voice: "Voice",
  music: "Music",
  sfx: "Sound effects",
  imageUpscale: "Image upscale",
  videoUpscale: "Video upscale",
};

const STATE_LABELS: Record<string, string> = {
  ready: "Ready",
  missing_executable: "CLI missing",
  check_failed: "Check failed",
};

interface Draft {
  enabled: "" | "on" | "off";
  waitTimeoutSeconds: string;
  models: Record<string, string>;
  voiceLanguageModels: string;
}

function draftOf(data: WorkspaceMultixSettings): Draft {
  const saved = data.workspace;
  return {
    enabled: saved?.enabled === true ? "on" : saved?.enabled === false ? "off" : "",
    waitTimeoutSeconds: saved?.waitTimeoutSeconds ? String(saved.waitTimeoutSeconds) : "",
    models: { ...(saved?.models ?? {}) },
    voiceLanguageModels: saved?.voiceLanguageModels ?? "",
  };
}

/**
 * The workspace's Multix settings: on/off, wait timeout, the model of each media role and the speech model per
 * language. A blank field keeps the server's MULTIX_* value. The Multix CLI version is fixed by the image.
 */
export function WorkspaceMultixSection() {
  const { data, error, reload } = useAsync(() => api.workspaceMultix());
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const [check, setCheck] = useState<WorkspaceMultixCheck>();

  useEffect(() => {
    if (data) setDraft(draftOf(data));
  }, [data]);

  async function act(action: () => Promise<unknown>) {
    setActionError(undefined);
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const models = Object.fromEntries(
      Object.entries(draft.models)
        .map(([role, model]) => [role, model.trim()])
        .filter(([, model]) => model !== ""),
    );
    await act(async () => {
      await api.updateWorkspaceMultix({
        enabled: draft.enabled === "" ? null : draft.enabled === "on",
        waitTimeoutSeconds: draft.waitTimeoutSeconds.trim() ? Number(draft.waitTimeoutSeconds) : null,
        models,
        voiceLanguageModels: draft.voiceLanguageModels.trim() || null,
      });
      reload();
    });
  }

  async function reset() {
    if (!window.confirm("Drop every Multix setting of this workspace and use the server settings again?"))
      return;
    await act(async () => {
      await api.resetWorkspaceMultix();
      reload();
    });
  }

  const readOnly = !data?.canChange || busy;
  return (
    <Section title="Multix media settings">
      <ErrorBanner error={error} />
      <ErrorBanner error={actionError} />
      <p className="muted">
        These settings apply to this workspace's media jobs and win over the server's MULTIX_* settings. Leave
        a field blank to use the server value. Vendor keys are set below.
      </p>
      {data && draft && (
        <form onSubmit={save}>
          <div className="row">
            <label>
              Multix{" "}
              <select
                value={draft.enabled}
                disabled={readOnly}
                onChange={(e) => setDraft({ ...draft, enabled: e.target.value as Draft["enabled"] })}
              >
                <option value="">Server default ({data.server.enabled ? "on" : "off"})</option>
                <option value="on">On</option>
                <option value="off">Off for this workspace</option>
              </select>
            </label>{" "}
            <StatusBadge
              status={data.effective.enabled.value ? "configured" : "missing"}
              label={data.effective.enabled.value ? "Enabled" : "Disabled"}
            />
            {!data.server.enabled && (
              <span className="muted"> The server has no Multix CLI (MULTIX_BIN).</span>
            )}
          </div>
          <div className="row">
            <label>
              Wait timeout (seconds){" "}
              <input
                type="number"
                min={30}
                max={7200}
                placeholder={String(data.server.waitTimeoutSeconds)}
                value={draft.waitTimeoutSeconds}
                disabled={readOnly}
                onChange={(e) => setDraft({ ...draft, waitTimeoutSeconds: e.target.value })}
              />
            </label>
          </div>
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Model in use</th>
                <th>Workspace model</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.effective.models).map(([role, effective]) => (
                <tr key={role}>
                  <td>{ROLE_LABELS[role] ?? role}</td>
                  <td>
                    <span className="mono">{effective.value}</span>{" "}
                    <StatusBadge
                      status={effective.source === "workspace" ? "configured" : "missing"}
                      label={effective.source}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`${ROLE_LABELS[role] ?? role} model`}
                      className="mono"
                      placeholder={data.server.models[role]}
                      value={draft.models[role] ?? ""}
                      disabled={readOnly}
                      onChange={(e) =>
                        setDraft({ ...draft, models: { ...draft.models, [role]: e.target.value } })
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <label>
            Speech model per language (<span className="mono">vi=vendor:model@voice,en=...</span>)
            <textarea
              className="mono"
              rows={2}
              placeholder={data.server.voiceLanguageModels ?? ""}
              value={draft.voiceLanguageModels}
              disabled={readOnly}
              onChange={(e) => setDraft({ ...draft, voiceLanguageModels: e.target.value })}
            />
          </label>
          {data.canChange && (
            <div className="row">
              <button type="submit" disabled={busy}>
                Save
              </button>
              <button type="button" disabled={busy || !data.workspace} onClick={reset}>
                Use server settings
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => act(async () => setCheck(await api.checkWorkspaceMultix()))}
              >
                Check Multix
              </button>
            </div>
          )}
          {data.updatedAt && <p className="muted">Last changed {formatDate(data.updatedAt)}</p>}
        </form>
      )}
      {check && (
        <div>
          <p>
            Multix CLI <span className="mono">{check.version ?? "unknown"}</span>{" "}
            <StatusBadge
              status={check.diagnosis.state === "ready" ? "configured" : "missing"}
              label={STATE_LABELS[check.diagnosis.state] ?? check.diagnosis.state}
            />
            {check.diagnosis.reason && <span className="muted"> {check.diagnosis.reason}</span>}
          </p>
          {check.diagnosis.state === "ready" && (
            <p className="muted">
              Platform keys found:{" "}
              {Object.entries(check.diagnosis.vendors)
                .filter(([, has]) => has)
                .map(([vendor]) => vendor)
                .join(", ") || "none"}
            </p>
          )}
        </div>
      )}
    </Section>
  );
}
