import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  type AgentRuntimeName,
  api,
  type CatalogProvider,
  type ChatGptLoginStart,
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

const STAGE_LABELS: Record<string, string> = { default: "Every step", plan: "Planning" };
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
      {connections.data && <CodexCard list={connections.data} reload={reload} />}
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
    <Section title="AI keys">
      <p className="muted">
        Each key is billed by its own provider account. Test sends one tiny prompt (at most 1¢).
      </p>
      {unavailable && (
        <p className="banner banner-error">Encrypted key storage is not configured on this server.</p>
      )}
      {(list.canAddWorkspaceKey || list.canAddPersonalKey) && (
        <form className="key-add" onSubmit={add}>
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
            {list.canAddPersonalKey && <option value="user">Personal</option>}
            {list.canAddWorkspaceKey && <option value="workspace">Workspace (shared)</option>}
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
        <details className="why">
          <summary>
            Paste an API key: {providerName(catalog, provider)} subscription sign-ins can't be used here.
          </summary>
          <p className="muted">{catalog.find((p) => p.id === provider)?.oauthRestriction}</p>
        </details>
      )}
      <ErrorBanner error={error} />
      {list.connections.length === 0 && <Empty>No provider keys connected.</Empty>}
      {list.connections.length > 0 && (
        <ul className="key-list">
          {list.connections.map((c) => {
            const runtimes: Array<{ id: AgentRuntimeName; name: string; locked?: boolean }> = [
              { id: "pi", name: "Pi", locked: c.authMethod === "oauth_subscription" },
              ...(c.provider === "openai"
                ? [{ id: "codex" as const, name: "Codex", locked: c.authMethod === "oauth_subscription" }]
                : []),
              ...(c.provider === "anthropic" ? [{ id: "claude" as const, name: "Claude" }] : []),
            ];
            return (
              <li key={c.id} className="key-row">
                <div className="key-main">
                  <div className="key-title">
                    <strong>{providerName(catalog, c.provider)}</strong>
                    <LabelCell
                      connection={c}
                      busy={busy.has(c.id)}
                      onSave={(label) => act(c.id, () => api.renameProviderConnection(c.id, label))}
                    />
                  </div>
                  <div className="key-meta">
                    <span className="mono">{c.keyHint ?? "-"}</span>
                    <span>
                      {c.owner === "workspace" ? "Workspace" : c.ownedByMe ? "Personal (you)" : "Personal"}
                    </span>
                    <span>{c.lastTest ? `Tested ${formatDate(c.lastTest.at)}` : "Never tested"}</span>
                  </div>
                  {c.lastTest && !c.lastTest.ok && c.lastTest.error && (
                    <div className="key-error">{c.lastTest.error.message}</div>
                  )}
                </div>
                <div className="key-state">
                  <StatusBadge status={c.status} label={STATUS_LABELS[c.status] ?? c.status} />
                  <fieldset className="runtime-chips" aria-label="Runtimes that use this key">
                    {runtimes.map((r) => {
                      const on = c.runtimes.includes(r.id);
                      return (
                        <label key={r.id} className={`runtime-chip${on ? " on" : ""}`}>
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={
                              !c.canManage ||
                              busy.has(c.id) ||
                              r.locked ||
                              (c.runtimes.length === 1 && c.runtimes[0] === r.id)
                            }
                            onChange={(e) => toggleRuntime(c, r.id, e.target.checked)}
                          />
                          {r.name}
                        </label>
                      );
                    })}
                  </fieldset>
                </div>
                {c.canManage && replacing?.id !== c.id && (
                  <div className="key-actions">
                    <button
                      type="button"
                      className="secondary small"
                      disabled={busy.has(c.id)}
                      onClick={() => act(c.id, () => api.testProviderKey(c.id))}
                    >
                      {busy.has(c.id) ? "Testing…" : "Test"}
                    </button>
                    {c.authMethod === "api_key" && (
                      <button
                        type="button"
                        className="secondary small"
                        disabled={unavailable || busy.has(c.id)}
                        onClick={() => setReplacing({ id: c.id, apiKey: "" })}
                      >
                        Replace
                      </button>
                    )}
                    <button
                      type="button"
                      className="ghost-danger small"
                      disabled={busy.has(c.id)}
                      onClick={() => remove(c)}
                    >
                      Remove
                    </button>
                  </div>
                )}
                {c.canManage && replacing?.id === c.id && (
                  <form className="key-replace" onSubmit={replace}>
                    <input
                      required
                      type="password"
                      autoComplete="new-password"
                      aria-label="New provider API key"
                      placeholder="New API key"
                      value={replacing.apiKey}
                      disabled={busy.has(c.id)}
                      onChange={(e) => setReplacing({ id: c.id, apiKey: e.target.value })}
                    />
                    <button type="submit" className="small" disabled={busy.has(c.id)}>
                      Test &amp; save
                    </button>
                    <button type="button" className="secondary small" onClick={() => setReplacing(undefined)}>
                      Cancel
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/** The connection's label, renamed in place: Enter or Save commits, Esc cancels. */
function LabelCell({
  connection,
  busy,
  onSave,
}: {
  connection: ProviderConnection;
  busy: boolean;
  onSave: (label: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const editing = draft !== undefined;
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  if (!editing) {
    return (
      <span className="key-label">
        {connection.label}
        {connection.canManage && (
          <button
            type="button"
            className="icon-btn"
            aria-label={`Rename ${connection.label}`}
            title="Rename"
            disabled={busy}
            onClick={() => setDraft(connection.label)}
          >
            ✎
          </button>
        )}
      </span>
    );
  }
  const label = draft.trim();
  async function commit(event: FormEvent) {
    event.preventDefault();
    if (!label || label.length > 80) return;
    if (label !== connection.label) await onSave(label);
    setDraft(undefined);
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") setDraft(undefined);
  }
  return (
    <form className="key-label" onSubmit={commit}>
      <input
        ref={input}
        aria-label="Connection label"
        maxLength={80}
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className="small" disabled={busy || !label}>
        Save
      </button>
      <button type="button" className="secondary small" onClick={() => setDraft(undefined)}>
        Cancel
      </button>
    </form>
  );
}

/**
 * Connects the Codex runtime: "Sign in with ChatGPT" (device code; the login is stored sealed and billed to
 * the ChatGPT plan), or an OpenAI API key above with its Codex box ticked.
 */
function CodexCard({ list, reload }: { list: ProviderConnectionList; reload: () => void }) {
  const [owner, setOwner] = useState<"workspace" | "user">(list.canAddPersonalKey ? "user" : "workspace");
  const [flow, setFlow] = useState<ChatGptLoginStart>();
  const [error, setError] = useState<unknown>();
  const [starting, setStarting] = useState(false);
  const unavailable = list.storage === "unavailable";
  const codex = list.connections.filter((c) => c.runtimes.includes("codex"));
  // A new reload callback every render must not restart the polling loop.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    if (!flow) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = (delaySeconds: number) => {
      timer = setTimeout(async () => {
        try {
          const result = await api.pollChatGptLogin(flow.flowToken);
          if (stopped) return;
          if (result.status === "connected") {
            setFlow(undefined);
            reloadRef.current();
          } else {
            poll(result.intervalSeconds);
          }
        } catch (e) {
          if (stopped) return;
          setError(e);
          setFlow(undefined);
        }
      }, delaySeconds * 1000);
    };
    poll(flow.intervalSeconds);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [flow]);

  async function start() {
    setError(undefined);
    setStarting(true);
    try {
      setFlow(await api.startChatGptLogin(owner));
    } catch (e) {
      setError(e);
    } finally {
      setStarting(false);
    }
  }

  return (
    <Section title="ChatGPT sign-in">
      <p className="muted">
        Use your ChatGPT plan for Codex tasks. Prefer paying by usage? Add an OpenAI key above and tick Codex.
      </p>
      {(list.canAddWorkspaceKey || list.canAddPersonalKey) && !flow && (
        <div className="row">
          <select
            aria-label="ChatGPT login owner"
            value={owner}
            disabled={unavailable}
            onChange={(e) => setOwner(e.target.value as "workspace" | "user")}
          >
            {list.canAddPersonalKey && <option value="user">Personal — only you</option>}
            {list.canAddWorkspaceKey && <option value="workspace">Workspace — shared with members</option>}
          </select>
          <button type="button" disabled={unavailable || starting} onClick={start}>
            {starting ? "Starting…" : "Sign in with ChatGPT"}
          </button>
        </div>
      )}
      {flow && (
        <div>
          <p>
            Open{" "}
            <a href={flow.verificationUrl} target="_blank" rel="noreferrer">
              {flow.verificationUrl}
            </a>{" "}
            and enter the code <strong className="mono">{flow.userCode}</strong>. This page updates once you
            approve it; the code expires {formatDate(flow.expiresAt)}.
          </p>
          <button type="button" className="secondary small" onClick={() => setFlow(undefined)}>
            Cancel
          </button>
        </div>
      )}
      <ErrorBanner error={error} />
      {codex.length === 0 && <Empty>No connection runs Codex yet.</Empty>}
      {codex.length > 0 && (
        <ul>
          {codex.map((c) => (
            <li key={c.id}>
              {c.label} · {c.authMethod === "oauth_subscription" ? "ChatGPT plan" : "OpenAI API key"} ·{" "}
              {STATUS_LABELS[c.status] ?? c.status}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function modelName(catalog: CatalogProvider[], provider: string, modelId: string) {
  return modelsOf(catalog, provider).find((m) => m.id === modelId)?.name ?? modelId;
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
  const canEdit = canEditWorkspace || canEditPersonal;
  const previewKey = preferences.map((p) => p.updatedAt).join();
  return (
    <Section title="AI model">
      <p className="muted">The model that writes and plans your videos. Running jobs keep their model.</p>
      <ErrorBanner error={error} />
      <StagePreview key={`default-${previewKey}`} stage="default" catalog={catalog} />
      {canEdit && (
        <DefaultModelForm
          catalog={catalog}
          connections={piConnections}
          scope={canEditPersonal ? "user" : "workspace"}
          busy={busy.has("default")}
          onSave={(input) => act("default", () => api.saveModelPreference(input))}
        />
      )}
      <details className="advanced">
        <summary>Advanced: a model per step, fallbacks and workspace choices</summary>
        <p className="muted">
          The most specific choice wins: yours for a step, the workspace's for it, your default, then the
          workspace default.
        </p>
        {stages
          .filter((stage) => stage !== "default")
          .map((stage) => (
            <StagePreview key={`${stage}-${previewKey}`} stage={stage} catalog={catalog} />
          ))}
        {preferences.length > 0 && (
          <ul className="key-list">
            {preferences.map((p) => (
              <li key={p.id} className="key-row">
                <div className="key-main">
                  <div className="key-title">
                    <strong>{STAGE_LABELS[p.stage] ?? p.stage}</strong>
                    <span>{modelName(catalog, p.provider, p.modelId)}</span>
                  </div>
                  <div className="key-meta">
                    <span>{p.scope === "workspace" ? "Whole workspace" : "Just for you"}</span>
                    <span>{label(p.connectionId)}</span>
                    <span>
                      {p.allowFallback && p.fallbacks.length > 0
                        ? `Fallback: ${p.fallbacks.map((f) => modelName(catalog, f.provider, f.modelId)).join(", ")}`
                        : "No fallback"}
                    </span>
                  </div>
                </div>
                <span />
                {p.canManage && (
                  <div className="key-actions">
                    <button
                      type="button"
                      className="ghost-danger small"
                      disabled={busy.has(p.id)}
                      onClick={() => act(p.id, () => api.removeModelPreference(p.id))}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
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
      </details>
    </Section>
  );
}

/** The everyday choice: one key and one model for every step. */
function DefaultModelForm({
  catalog,
  connections,
  scope,
  busy,
  onSave,
}: {
  catalog: CatalogProvider[];
  connections: ProviderConnection[];
  scope: "workspace" | "user";
  busy: boolean;
  onSave: (input: Parameters<typeof api.saveModelPreference>[0]) => Promise<void>;
}) {
  const usable = connections.filter((c) => c.owner === "workspace" || (scope === "user" && c.ownedByMe));
  const [connectionId, setConnectionId] = useState("");
  const [modelId, setModelId] = useState("");
  const chosen = connectionId || usable[0]?.id || "";
  const provider = connections.find((c) => c.id === chosen)?.provider;
  if (usable.length === 0) return <Empty>Add an AI key above, then pick its model here.</Empty>;

  async function save(event: FormEvent) {
    event.preventDefault();
    await onSave({ scope, stage: "default", connectionId: chosen, modelId });
    setModelId("");
  }
  return (
    <form className="key-add" onSubmit={save}>
      {usable.length > 1 && (
        <select
          aria-label="Key"
          value={chosen}
          onChange={(e) => {
            setConnectionId(e.target.value);
            setModelId("");
          }}
        >
          {usable.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} ({providerName(catalog, c.provider)})
            </option>
          ))}
        </select>
      )}
      <select required aria-label="Model" value={modelId} onChange={(e) => setModelId(e.target.value)}>
        <option value="">Choose a model…</option>
        {modelsOf(catalog, provider).map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} · ${m.cost.input}/${m.cost.output} per M tokens
          </option>
        ))}
      </select>
      <button type="submit" disabled={busy || !modelId}>
        Use this model
      </button>
    </form>
  );
}

function StagePreview({ stage, catalog }: { stage: string; catalog: CatalogProvider[] }) {
  const { data, error } = useAsync(() => api.modelPreview(stage), [stage]);
  if (error) return <ErrorBanner error={error} />;
  if (!data) return null;
  const selection = data.selection;
  return (
    <p>
      <strong>{stage === "default" ? "In use" : (STAGE_LABELS[stage] ?? stage)}:</strong>{" "}
      {selection ? (
        <>
          {modelName(catalog, selection.preference.provider, selection.preference.modelId)}{" "}
          <span className="muted">
            ({providerName(catalog, selection.preference.provider)},{" "}
            {SOURCE_LABELS[selection.source] ?? selection.source})
          </span>
          {!selection.usable && (
            <span className="banner-error"> Cannot run: {selection.problem ?? "the key is not usable"}.</span>
          )}
        </>
      ) : (
        <span className="muted">Studix picks a model for you</span>
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
    return <Empty>Add an AI key above to choose a model.</Empty>;
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
