import { type FormEvent, useState } from "react";
import {
  type AgentRuntimeName,
  api,
  type CatalogProvider,
  type ModelPreference,
  type ProviderConnection,
  type ProviderConnectionList,
} from "../api-client.ts";
import { Empty, ErrorBanner, formatDate, Section, StatusBadge, useAsync } from "../ui.tsx";

/*
 * Provider keys for the Pi runtime and the model each workflow stage uses. Keys of every provider live in
 * one list; each key says which agent runtimes may spend it. Anthropic keys start enabled for Claude only,
 * so using one with Pi is an explicit opt-in by whoever manages the key.
 */

const STAGE_LABELS: Record<string, string> = { default: "Default (every stage)", plan: "Planning" };
const SOURCE_LABELS: Record<string, string> = {
  "user-stage": "your choice for this stage",
  "workspace-stage": "the workspace choice for this stage",
  "user-default": "your default",
  "workspace-default": "the workspace default",
};
const STATUS_LABELS: Record<string, string> = {
  available: "Available",
  invalid: "Invalid",
  unverified: "Unverified",
};

function modelsOf(catalog: CatalogProvider[], provider: string | undefined) {
  return catalog.find((p) => p.id === provider)?.models ?? [];
}

function providerName(catalog: CatalogProvider[], provider: string) {
  return catalog.find((p) => p.id === provider)?.name ?? provider;
}

function useActions(reload: () => void) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<unknown>();
  /** Runs one action; `key` marks only the control that started it as busy. */
  async function act(key: string, action: () => Promise<unknown>) {
    setError(undefined);
    setBusy((s) => new Set(s).add(key));
    try {
      await action();
      reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }
  return { busy, error, act };
}

export function ProviderModelsSection() {
  const catalog = useAsync(() => api.providerCatalog());
  const connections = useAsync(() => api.providerConnections());
  const preferences = useAsync(() => api.modelPreferences());
  const reload = () => {
    connections.reload();
    preferences.reload();
  };
  const providers = catalog.data?.providers ?? [];
  return (
    <>
      <ErrorBanner error={catalog.error ?? connections.error ?? preferences.error} />
      {connections.data && <ProviderKeysCard catalog={providers} list={connections.data} reload={reload} />}
      {connections.data && preferences.data && (
        <ModelsCard
          catalog={providers}
          connections={connections.data.connections}
          stages={preferences.data.stages}
          preferences={preferences.data.preferences}
          canEditWorkspace={preferences.data.canEditWorkspace}
          canEditPersonal={preferences.data.canEditPersonal}
          reload={reload}
        />
      )}
    </>
  );
}

function ProviderKeysCard({
  catalog,
  list,
  reload,
}: {
  catalog: CatalogProvider[];
  list: ProviderConnectionList;
  reload: () => void;
}) {
  const [provider, setProvider] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [owner, setOwner] = useState<"workspace" | "user">(list.canAddPersonalKey ? "user" : "workspace");
  const [label, setLabel] = useState("");
  const [replacing, setReplacing] = useState<{ id: string; apiKey: string }>();
  const { busy, error, act } = useActions(reload);
  const unavailable = list.storage === "unavailable";

  async function add(event: FormEvent) {
    event.preventDefault();
    const key = apiKey.trim();
    // The secret leaves component state as soon as it is sent, whether or not the provider accepts it.
    setApiKey("");
    await act("add", async () => {
      await api.addProviderKey({ provider, owner, apiKey: key, label: label.trim() || undefined });
      setLabel("");
    });
  }

  async function replace(event: FormEvent) {
    event.preventDefault();
    if (!replacing) return;
    const { id, apiKey: key } = replacing;
    setReplacing({ id, apiKey: "" });
    await act(id, async () => {
      await api.replaceProviderKey(id, key.trim());
      setReplacing(undefined);
    });
  }

  function toggleRuntime(c: ProviderConnection, runtime: AgentRuntimeName, on: boolean) {
    const next = on ? [...c.runtimes, runtime] : c.runtimes.filter((r) => r !== runtime);
    if (next.length === 0) return;
    void act(c.id, () => api.setProviderRuntimes(c.id, next));
  }

  async function remove(c: ProviderConnection) {
    const where = providerName(catalog, c.provider);
    if (!window.confirm(`Remove this key from Studix? It is not revoked at ${where}; revoke it there too.`))
      return;
    await act(c.id, () => api.removeProviderKey(c.id));
  }

  return (
    <Section title="Provider keys · Pi runtime">
      <p className="muted">
        Keys for any provider the Pi runtime supports, billed by usage to the key's own account. A test sends
        one short prompt to the provider's cheapest model (at most 1¢); Anthropic keys are tested for free.
      </p>
      {unavailable && (
        <p className="banner banner-error">Encrypted key storage is not configured on this server.</p>
      )}
      {(list.canAddWorkspaceKey || list.canAddPersonalKey) && (
        <form className="row" onSubmit={add}>
          <select
            aria-label="Provider"
            value={provider}
            disabled={unavailable}
            onChange={(e) => setProvider(e.target.value)}
          >
            {catalog.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            required
            type="password"
            autoComplete="new-password"
            aria-label="Provider API key"
            placeholder="API key"
            value={apiKey}
            disabled={unavailable || busy.has("add")}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <select
            aria-label="Key owner"
            value={owner}
            disabled={unavailable}
            onChange={(e) => setOwner(e.target.value as "workspace" | "user")}
          >
            {list.canAddPersonalKey && <option value="user">Personal key — only you</option>}
            {list.canAddWorkspaceKey && (
              <option value="workspace">Workspace key — shared with members</option>
            )}
          </select>
          <input
            maxLength={80}
            placeholder="Label (optional)"
            value={label}
            disabled={unavailable}
            onChange={(e) => setLabel(e.target.value)}
          />
          <button type="submit" disabled={unavailable || busy.has("add")}>
            Test &amp; save
          </button>
        </form>
      )}
      {catalog.find((p) => p.id === provider)?.oauthRestriction && (
        <p className="muted">{catalog.find((p) => p.id === provider)?.oauthRestriction}</p>
      )}
      <ErrorBanner error={error} />
      {list.connections.length === 0 && <Empty>No provider keys connected.</Empty>}
      {list.connections.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Label</th>
              <th>Owner</th>
              <th>Key</th>
              <th>Status</th>
              <th>Runtimes</th>
              <th>Last tested</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.connections.map((c) => (
              <tr key={c.id}>
                <td>{providerName(catalog, c.provider)}</td>
                <td>{c.label}</td>
                <td>{c.owner === "workspace" ? "Workspace" : c.ownedByMe ? "Personal (you)" : "Personal"}</td>
                <td className="mono">{c.keyHint ?? "-"}</td>
                <td>
                  <StatusBadge status={c.status} label={STATUS_LABELS[c.status] ?? c.status} />
                </td>
                <td>
                  <label className="row">
                    <input
                      type="checkbox"
                      checked={c.runtimes.includes("pi")}
                      disabled={
                        !c.canManage || busy.has(c.id) || (c.runtimes.length === 1 && c.runtimes[0] === "pi")
                      }
                      onChange={(e) => toggleRuntime(c, "pi", e.target.checked)}
                    />
                    Pi
                  </label>
                  {c.provider === "anthropic" && (
                    <label className="row">
                      <input
                        type="checkbox"
                        checked={c.runtimes.includes("claude")}
                        disabled={
                          !c.canManage ||
                          busy.has(c.id) ||
                          (c.runtimes.length === 1 && c.runtimes[0] === "claude")
                        }
                        onChange={(e) => toggleRuntime(c, "claude", e.target.checked)}
                      />
                      Claude
                    </label>
                  )}
                </td>
                <td>
                  {c.lastTest ? formatDate(c.lastTest.at) : "Never"}
                  {c.lastTest && !c.lastTest.ok && c.lastTest.error && (
                    <div className="muted">{c.lastTest.error.message}</div>
                  )}
                </td>
                <td>
                  {c.canManage && replacing?.id !== c.id && (
                    <div className="row">
                      <button
                        type="button"
                        className="secondary small"
                        disabled={busy.has(c.id)}
                        onClick={() => act(c.id, () => api.testProviderKey(c.id))}
                      >
                        {busy.has(c.id) ? "Testing…" : "Test"}
                      </button>
                      <button
                        type="button"
                        className="secondary small"
                        disabled={unavailable || busy.has(c.id)}
                        onClick={() => setReplacing({ id: c.id, apiKey: "" })}
                      >
                        Replace key
                      </button>
                      <button
                        type="button"
                        className="danger small"
                        disabled={busy.has(c.id)}
                        onClick={() => remove(c)}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                  {c.canManage && replacing?.id === c.id && (
                    <form className="row" onSubmit={replace}>
                      <input
                        required
                        type="password"
                        autoComplete="new-password"
                        aria-label="New provider API key"
                        value={replacing.apiKey}
                        disabled={busy.has(c.id)}
                        onChange={(e) => setReplacing({ id: c.id, apiKey: e.target.value })}
                      />
                      <button type="submit" className="small" disabled={busy.has(c.id)}>
                        Test &amp; save
                      </button>
                      <button
                        type="button"
                        className="secondary small"
                        onClick={() => setReplacing(undefined)}
                      >
                        Cancel
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function ModelsCard({
  catalog,
  connections,
  stages,
  preferences,
  canEditWorkspace,
  canEditPersonal,
  reload,
}: {
  catalog: CatalogProvider[];
  connections: ProviderConnection[];
  stages: string[];
  preferences: ModelPreference[];
  canEditWorkspace: boolean;
  canEditPersonal: boolean;
  reload: () => void;
}) {
  const { busy, error, act } = useActions(reload);
  const piConnections = connections.filter((c) => c.runtimes.includes("pi"));
  const label = (id: string) => {
    const c = connections.find((x) => x.id === id);
    return c ? `${c.label} (${providerName(catalog, c.provider)})` : "Removed key";
  };
  return (
    <Section title="Models per stage · Pi runtime">
      <p className="muted">
        Most specific wins: your choice for a stage, then the workspace choice for it, then your default, then
        the workspace default. A job that selects the Claude planner ignores these. Each job keeps the model
        it started with, even if you change it here.
      </p>
      <ErrorBanner error={error} />
      {stages.map((stage) => (
        <StagePreview key={`${stage}-${preferences.map((p) => p.updatedAt).join()}`} stage={stage} />
      ))}
      {preferences.length === 0 && <Empty>No models chosen; jobs use the operator's default routing.</Empty>}
      {preferences.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Stage</th>
              <th>Scope</th>
              <th>Key</th>
              <th>Model</th>
              <th>Fallback</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {preferences.map((p) => (
              <tr key={p.id}>
                <td>{STAGE_LABELS[p.stage] ?? p.stage}</td>
                <td>{p.scope === "workspace" ? "Workspace" : "Personal (you)"}</td>
                <td>{label(p.connectionId)}</td>
                <td className="mono">{p.modelId}</td>
                <td className="mono">
                  {p.allowFallback && p.fallbacks.length > 0
                    ? p.fallbacks.map((f) => `${f.provider} / ${f.modelId}`).join(", ")
                    : "None"}
                </td>
                <td>
                  {p.canManage && (
                    <button
                      type="button"
                      className="danger small"
                      disabled={busy.has(p.id)}
                      onClick={() => act(p.id, () => api.removeModelPreference(p.id))}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(canEditWorkspace || canEditPersonal) && (
        <ChooseModelForm
          catalog={catalog}
          connections={piConnections}
          stages={stages}
          canEditWorkspace={canEditWorkspace}
          canEditPersonal={canEditPersonal}
          busy={busy.has("save")}
          onSave={(input) => act("save", () => api.saveModelPreference(input))}
        />
      )}
    </Section>
  );
}

function StagePreview({ stage }: { stage: string }) {
  const { data, error } = useAsync(() => api.modelPreview(stage), [stage]);
  if (error) return <ErrorBanner error={error} />;
  if (!data) return null;
  const selection = data.selection;
  return (
    <p>
      <strong>{STAGE_LABELS[stage] ?? stage}:</strong>{" "}
      {selection ? (
        <>
          <span className="mono">
            {selection.preference.provider} / {selection.preference.modelId}
          </span>{" "}
          from {SOURCE_LABELS[selection.source] ?? selection.source}
          {!selection.usable && (
            <span className="banner-error">
              {" "}
              · cannot run: {selection.problem ?? "the key is not usable"}
            </span>
          )}
        </>
      ) : (
        <span className="muted">operator default routing</span>
      )}
    </p>
  );
}

function ChooseModelForm({
  catalog,
  connections,
  stages,
  canEditWorkspace,
  canEditPersonal,
  busy,
  onSave,
}: {
  catalog: CatalogProvider[];
  connections: ProviderConnection[];
  stages: string[];
  canEditWorkspace: boolean;
  canEditPersonal: boolean;
  busy: boolean;
  onSave: (input: Parameters<typeof api.saveModelPreference>[0]) => Promise<void>;
}) {
  const [scope, setScope] = useState<"workspace" | "user">(canEditPersonal ? "user" : "workspace");
  const [stage, setStage] = useState(stages[0] ?? "default");
  const [connectionId, setConnectionId] = useState("");
  const [modelId, setModelId] = useState("");
  const [fallbackConnectionId, setFallbackConnectionId] = useState("");
  const [fallbackModelId, setFallbackModelId] = useState("");
  // A workspace-wide choice may only use workspace keys; a personal one may also use your own keys.
  const usable = connections.filter((c) => c.owner === "workspace" || (scope === "user" && c.ownedByMe));
  const providerOf = (id: string) => connections.find((c) => c.id === id)?.provider;

  async function save(event: FormEvent) {
    event.preventDefault();
    const fallback = fallbackConnectionId && fallbackModelId;
    await onSave({
      scope,
      stage,
      connectionId,
      modelId,
      allowFallback: Boolean(fallback),
      fallbacks: fallback ? [{ connectionId: fallbackConnectionId, modelId: fallbackModelId }] : [],
    });
    setModelId("");
    setFallbackConnectionId("");
    setFallbackModelId("");
  }

  if (connections.length === 0) {
    return <Empty>Enable a provider key for the Pi runtime above to choose a model.</Empty>;
  }
  return (
    <form onSubmit={save}>
      <div className="row">
        <select
          aria-label="Scope"
          value={scope}
          onChange={(e) => setScope(e.target.value as "workspace" | "user")}
        >
          {canEditPersonal && <option value="user">Just for me</option>}
          {canEditWorkspace && <option value="workspace">Whole workspace</option>}
        </select>
        <select aria-label="Stage" value={stage} onChange={(e) => setStage(e.target.value)}>
          {stages.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABELS[s] ?? s}
            </option>
          ))}
        </select>
        <select
          required
          aria-label="Key"
          value={connectionId}
          onChange={(e) => {
            setConnectionId(e.target.value);
            setModelId("");
          }}
        >
          <option value="">Key…</option>
          {usable.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} ({providerName(catalog, c.provider)})
            </option>
          ))}
        </select>
        <select required aria-label="Model" value={modelId} onChange={(e) => setModelId(e.target.value)}>
          <option value="">Model…</option>
          {modelsOf(catalog, providerOf(connectionId)).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} · ${m.cost.input}/${m.cost.output} per M tokens
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <select
          aria-label="Fallback key"
          value={fallbackConnectionId}
          onChange={(e) => {
            setFallbackConnectionId(e.target.value);
            setFallbackModelId("");
          }}
        >
          <option value="">No fallback</option>
          {usable
            .filter((c) => c.id !== connectionId)
            .map((c) => (
              <option key={c.id} value={c.id}>
                Fallback: {c.label} ({providerName(catalog, c.provider)})
              </option>
            ))}
        </select>
        {fallbackConnectionId && (
          <select
            required
            aria-label="Fallback model"
            value={fallbackModelId}
            onChange={(e) => setFallbackModelId(e.target.value)}
          >
            <option value="">Fallback model…</option>
            {modelsOf(catalog, providerOf(fallbackConnectionId)).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
        <button type="submit" disabled={busy || !connectionId || !modelId}>
          Save choice
        </button>
      </div>
      <p className="muted">
        A fallback is tried only when the provider itself fails (outage, quota, rejected key) and may bill a
        different account. Without one, a failing model falls back to the free built-in rules.
      </p>
    </form>
  );
}
