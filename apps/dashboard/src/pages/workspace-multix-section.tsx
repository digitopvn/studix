import { type FormEvent, useEffect, useState } from "react";
import {
  api,
  type MultixCatalog,
  type WorkspaceMultixCheck,
  type WorkspaceMultixSettings,
} from "../api-client.ts";
import { ErrorBanner, formatDate, Section, StatusBadge, useAsync } from "../ui.tsx";
import { MultixModelCombobox } from "./multix-model-combobox.tsx";

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
/** Video first: it is the choice that matters most for a video project. */
const ROLE_ORDER = ["video", "image", "voice", "lipsync", "music", "sfx", "videoUpscale", "imageUpscale"];

const STATE_LABELS: Record<string, string> = {
  ready: "Ready",
  missing_executable: "Not installed",
  check_failed: "Check failed",
};

function roleRank(role: string) {
  const i = ROLE_ORDER.indexOf(role);
  return i === -1 ? ROLE_ORDER.length : i;
}

/** "sume:seedance-2-mini" -> "Seedance 2 mini (Sume)", for ids the catalogue gives no name for. */
export function readableModel(id: string): string {
  const colon = id.indexOf(":");
  if (colon === -1) return id;
  const vendor = id.slice(0, colon);
  const model =
    id
      .slice(colon + 1)
      .split("/")
      .pop() ?? "";
  const words = model.replace(/[-_]+/g, " ").trim();
  if (!words) return id;
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} (${vendor.charAt(0).toUpperCase()}${vendor.slice(1)})`;
}

export interface VoiceRow {
  language: string;
  model: string;
  voice: string;
}

/** `vi=vendor:model@voice,en=...` -> one row per language (the server validates the result on Save). */
export function parseVoiceRows(value: string): VoiceRow[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf("=");
      const target = eq === -1 ? entry : entry.slice(eq + 1).trim();
      const at = target.lastIndexOf("@");
      return {
        language: eq === -1 ? "" : entry.slice(0, eq).trim(),
        model: at === -1 ? target : target.slice(0, at),
        voice: at === -1 ? "" : target.slice(at + 1),
      };
    });
}

export function formatVoiceRows(rows: readonly VoiceRow[]): string {
  return rows
    .map((r) => ({ language: r.language.trim().toLowerCase(), model: r.model.trim(), voice: r.voice.trim() }))
    .filter((r) => r.language && r.model)
    .map((r) => `${r.language}=${r.model}${r.voice ? `@${r.voice}` : ""}`)
    .join(",");
}

interface Draft {
  enabled: "" | "on" | "off";
  waitTimeoutSeconds: string;
  models: Record<string, string>;
  voices: VoiceRow[];
}

function draftOf(data: WorkspaceMultixSettings): Draft {
  const saved = data.workspace;
  return {
    enabled: saved?.enabled === true ? "on" : saved?.enabled === false ? "off" : "",
    waitTimeoutSeconds: saved?.waitTimeoutSeconds ? String(saved.waitTimeoutSeconds) : "",
    models: { ...(saved?.models ?? {}) },
    voices: parseVoiceRows(saved?.voiceLanguageModels ?? ""),
  };
}

/**
 * The workspace's media settings: on/off, the model of each media kind and the speech model per language.
 * A blank field keeps the server's value. Timeouts and engine checks sit under Advanced.
 */
export function WorkspaceMultixSection() {
  const { data, error, reload } = useAsync(() => api.workspaceMultix());
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const [check, setCheck] = useState<WorkspaceMultixCheck>();
  const [catalog, setCatalog] = useState<MultixCatalog>();
  const [editing, setEditing] = useState(false);
  const canChange = data?.canChange === true;

  // Only people who may change the models need the list; a failed read leaves free-text entry working.
  useEffect(() => {
    if (!canChange) return;
    api.multixCatalog().then(setCatalog, () => setCatalog(undefined));
  }, [canChange]);

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
        voiceLanguageModels: formatVoiceRows(draft.voices) || null,
      });
      setEditing(false);
      reload();
    });
  }

  async function reset() {
    if (!window.confirm("Drop every media setting of this workspace and use the Studix defaults again?"))
      return;
    await act(async () => {
      await api.resetWorkspaceMultix();
      reload();
    });
  }

  /** The catalogue's friendly name for a model id, when it has one. */
  function friendly(role: string, id: string) {
    if (!id.includes(":")) return "Auto";
    return catalog?.roles[role]?.find((e) => e.id === id)?.label ?? readableModel(id);
  }

  function setVoice(index: number, patch: Partial<VoiceRow>) {
    if (!draft) return;
    setDraft({ ...draft, voices: draft.voices.map((r, i) => (i === index ? { ...r, ...patch } : r)) });
  }

  const readOnly = !data?.canChange || busy;
  const roles = data ? Object.keys(data.effective.models).sort((a, b) => roleRank(a) - roleRank(b)) : [];
  return (
    <Section
      title="Image & video models"
      actions={
        data && (
          <div className="row">
            {!data.effective.enabled.value && <StatusBadge status="missing" label="Media off" />}
            {data.canChange && (
              <button
                type="button"
                className="secondary small"
                onClick={() => {
                  if (editing) setDraft(draftOf(data));
                  setEditing(!editing);
                }}
              >
                {editing ? "Cancel" : "Change"}
              </button>
            )}
          </div>
        )
      }
    >
      <ErrorBanner error={error} />
      <ErrorBanner error={actionError} />
      <p className="muted">
        Studix picks a good model for each kind of media.{" "}
        {editing
          ? "Leave a field blank to keep the Studix pick."
          : "Change any of them if you prefer another."}
      </p>
      {data && !data.server.enabled && (
        <p className="muted">Media generation is not installed on this server, so these settings wait.</p>
      )}
      {data && draft && (
        <form onSubmit={save}>
          <ul className="key-list">
            {roles.map((role) => {
              const effective = data.effective.models[role];
              if (!effective) return null;
              return (
                <li key={role} className="key-row media-role">
                  <div className="key-main">
                    <strong>{ROLE_LABELS[role] ?? role}</strong>
                    <div className="key-meta">
                      <span>{friendly(role, effective.value)}</span>
                    </div>
                  </div>
                  {effective.source === "workspace" ? (
                    <StatusBadge status="configured" label="Your pick" />
                  ) : (
                    <span />
                  )}
                  {editing && (
                    <MultixModelCombobox
                      label={`${ROLE_LABELS[role] ?? role} model`}
                      serverValue={data.server.models[role] ?? ""}
                      value={draft.models[role] ?? ""}
                      entries={catalog?.roles[role] ?? []}
                      openVendors={catalog?.openVendors ?? []}
                      disabled={readOnly}
                      onChange={(value) => setDraft({ ...draft, models: { ...draft.models, [role]: value } })}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          {editing && (
            <>
              {catalog && catalog.errors.length > 0 && (
                <p className="muted">
                  Some models could not be listed right now; you can still type a model id.
                </p>
              )}
              <h3>Voice per language</h3>
              <p className="muted">
                Narration in these languages uses the model you set here; other languages use the Voice model
                above.
              </p>
              {draft.voices.length === 0 && <p className="muted">No language has its own voice yet.</p>}
              {draft.voices.map((row, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id and are edited in place.
                <div className="key-add voice-row" key={index}>
                  <input
                    aria-label="Language code"
                    placeholder="Language (e.g. vi)"
                    maxLength={3}
                    value={row.language}
                    disabled={readOnly}
                    onChange={(e) => setVoice(index, { language: e.target.value })}
                  />
                  <MultixModelCombobox
                    label="Speech model"
                    serverValue=""
                    value={row.model}
                    entries={catalog?.roles.voice ?? []}
                    openVendors={catalog?.openVendors ?? []}
                    disabled={readOnly}
                    onChange={(model) => setVoice(index, { model })}
                  />
                  <input
                    aria-label="Voice name"
                    placeholder="Voice (optional)"
                    value={row.voice}
                    disabled={readOnly}
                    onChange={(e) => setVoice(index, { voice: e.target.value })}
                  />
                  {data.canChange && (
                    <button
                      type="button"
                      className="ghost-danger small"
                      disabled={busy}
                      onClick={() =>
                        setDraft({ ...draft, voices: draft.voices.filter((_, i) => i !== index) })
                      }
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
              {data.canChange && (
                <button
                  type="button"
                  className="secondary small"
                  disabled={busy}
                  onClick={() =>
                    setDraft({ ...draft, voices: [...draft.voices, { language: "", model: "", voice: "" }] })
                  }
                >
                  Add a language
                </button>
              )}
              {data.canChange && (
                <div className="row form-actions">
                  <button type="submit" disabled={busy}>
                    Save
                  </button>
                  {data.updatedAt && <span className="muted">Last changed {formatDate(data.updatedAt)}</span>}
                </div>
              )}
              <details className="advanced">
                <summary>Advanced</summary>
                <div className="row">
                  <label>
                    Media generation{" "}
                    <select
                      value={draft.enabled}
                      disabled={readOnly}
                      onChange={(e) => setDraft({ ...draft, enabled: e.target.value as Draft["enabled"] })}
                    >
                      <option value="">Studix default ({data.server.enabled ? "on" : "off"})</option>
                      <option value="on">On</option>
                      <option value="off">Off for this workspace</option>
                    </select>
                  </label>
                </div>
                <div className="row">
                  <label>
                    Give up on a media job after (seconds){" "}
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
                {data.canChange && (
                  <div className="row">
                    <button
                      type="button"
                      className="secondary small"
                      disabled={busy}
                      onClick={() => act(async () => setCheck(await api.checkWorkspaceMultix()))}
                    >
                      Check media engine
                    </button>
                    <button
                      type="button"
                      className="ghost-danger small"
                      disabled={busy || !data.workspace}
                      onClick={reset}
                    >
                      Reset to Studix defaults
                    </button>
                  </div>
                )}
                {check && (
                  <p>
                    Media engine {check.version ?? ""}{" "}
                    <StatusBadge
                      status={check.diagnosis.state === "ready" ? "configured" : "missing"}
                      label={STATE_LABELS[check.diagnosis.state] ?? check.diagnosis.state}
                    />
                    {check.diagnosis.reason && <span className="muted"> {check.diagnosis.reason}</span>}
                    {check.diagnosis.state === "ready" && (
                      <span className="muted">
                        {" "}
                        Billed by Studix for:{" "}
                        {Object.entries(check.diagnosis.vendors)
                          .filter(([, has]) => has)
                          .map(([vendor]) => vendor)
                          .join(", ") || "none"}
                      </span>
                    )}
                  </p>
                )}
              </details>
            </>
          )}
        </form>
      )}
    </Section>
  );
}
