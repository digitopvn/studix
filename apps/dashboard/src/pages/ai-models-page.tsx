import { type FormEvent, useState } from "react";
import {
  api,
  type ModelPreference,
  type ProviderCatalogEntry,
  type ProviderConnection,
} from "../api-client.ts";
import { Empty, ErrorBanner, formatDate, Section, StatusBadge, useAsync } from "../ui.tsx";

const STAGES: Record<string, string> = {
  default: "All stages",
  plan: "Planning (brief)",
};

const SOURCES: Record<string, string> = {
  "user-stage": "your choice for this stage",
  "workspace-stage": "workspace choice for this stage",
  "user-default": "your default",
  "workspace-default": "workspace default",
};

/** Roles that may change workspace-owned keys and workspace defaults (`provider:manage`). */
const MANAGERS = new Set(["owner", "admin"]);
/** Roles that may connect personal keys and choose models for their own jobs (`provider:connect`). */
const CONNECTORS = new Set(["owner", "admin", "editor"]);

const ownerText = (owner: ProviderConnection["owner"]) =>
  owner.type === "workspace" ? "Workspace" : "Personal";

function modelsOf(catalog: ProviderCatalogEntry[] | undefined, provider: string | undefined) {
  return catalog?.find((p) => p.id === provider)?.models ?? [];
}

/**
 * Settings > AI & Models: connect provider API keys (workspace-wide or personal), choose the model each
 * stage runs on, and see which model will actually be used. Keys are write-only from here on.
 */
export function AiModelsPage({ role }: { role: string }) {
  const canManage = MANAGERS.has(role);
  const canConnect = CONNECTORS.has(role);
  const catalog = useAsync(() => api.providerCatalog());
  const connections = useAsync(() => api.providerConnections());
  const preferences = useAsync(() => api.modelPreferences());
  const resolution = useAsync(() => api.modelResolution());
  const [actionError, setActionError] = useState<unknown>();

  const reloadAll = () => {
    connections.reload();
    preferences.reload();
    resolution.reload();
  };
  async function act(action: () => Promise<unknown>) {
    setActionError(undefined);
    try {
      await action();
      reloadAll();
    } catch (e) {
      setActionError(e);
    }
  }

  const connectionById = new Map((connections.data?.items ?? []).map((c) => [c.id, c]));
  const unavailable = catalog.error ?? connections.error;

  return (
    <>
      <ErrorBanner error={unavailable} />
      <ErrorBanner error={actionError} />
      <Section title="Models in use">
        <ErrorBanner error={resolution.error} />
        {resolution.data && (
          <table>
            <thead>
              <tr>
                <th>Stage</th>
                <th>Model</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {resolution.data.items.map((r) => (
                <tr key={r.stage}>
                  <td>{STAGES[r.stage] ?? r.stage}</td>
                  <td className="mono">
                    {r.choice ? `${r.choice.provider} / ${r.choice.modelId}` : "Studix default"}
                  </td>
                  <td className="muted">
                    {r.choice
                      ? `${SOURCES[r.choice.source] ?? r.choice.source} via "${connectionById.get(r.choice.connectionId)?.label ?? "connection"}"`
                      : "No model chosen; the server's own setup is used."}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">
          A job keeps the model it started with, even if you change the choice while it runs. If your model
          fails, the job continues with the built-in rules, never with another paid provider, unless you allow
          a fallback.
        </p>
      </Section>
      {canConnect ? (
        <AddConnection catalog={catalog.data?.items} canManage={canManage} onAdded={reloadAll} />
      ) : (
        <p className="muted">
          Your role can see the models in use; an owner, admin or editor connects providers.
        </p>
      )}
      <Connections
        items={connections.data?.items}
        catalog={catalog.data?.items}
        canManage={canManage}
        canConnect={canConnect}
        act={act}
      />
      <Preferences
        items={preferences.data?.items}
        connections={connections.data?.items ?? []}
        catalog={catalog.data?.items}
        canManage={canManage}
        canConnect={canConnect}
        act={act}
      />
    </>
  );
}

function AddConnection({
  catalog,
  canManage,
  onAdded,
}: {
  catalog?: ProviderCatalogEntry[];
  canManage: boolean;
  onAdded: () => void;
}) {
  const [provider, setProvider] = useState("");
  const [label, setLabel] = useState("");
  const [owner, setOwner] = useState<"workspace" | "personal">(canManage ? "workspace" : "personal");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<unknown>();
  const entry = catalog?.find((p) => p.id === provider);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      await api.addProviderConnection({ provider, label: label.trim(), owner, apiKey: apiKey.trim() });
      setApiKey("");
      setLabel("");
      onAdded();
    } catch (e) {
      setError(e);
    } finally {
      // Never keep the key around longer than the request.
      setApiKey("");
    }
  }

  return (
    <Section title="Connect a provider">
      <form className="row" onSubmit={submit} autoComplete="off">
        <select required aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="">Provider...</option>
          {catalog?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          required
          maxLength={60}
          placeholder="Label (e.g. Team key)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <select
          aria-label="Owner"
          value={owner}
          onChange={(e) => setOwner(e.target.value as "workspace" | "personal")}
        >
          <option value="workspace" disabled={!canManage}>
            Workspace (shared)
          </option>
          <option value="personal">Personal (only my jobs)</option>
        </select>
        <input
          required
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          minLength={8}
          placeholder="API key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <button type="submit">Connect</button>
      </form>
      {entry?.oauthRestriction && <p className="muted">{entry.oauthRestriction}</p>}
      <p className="muted">
        The key is encrypted on the server and never shown again. Usage is billed by the provider to this key.
      </p>
      <ErrorBanner error={error} />
    </Section>
  );
}

function Connections({
  items,
  catalog,
  canManage,
  canConnect,
  act,
}: {
  items?: ProviderConnection[];
  catalog?: ProviderCatalogEntry[];
  canManage: boolean;
  canConnect: boolean;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [rotating, setRotating] = useState<string>();
  const [newKey, setNewKey] = useState("");
  // A test is a paid provider call; one at a time per connection.
  const [testing, setTesting] = useState<string>();

  async function test(id: string) {
    setTesting(id);
    try {
      await act(() => api.testProviderConnection(id));
    } finally {
      setTesting(undefined);
    }
  }

  async function rotate(event: FormEvent, id: string) {
    event.preventDefault();
    const key = newKey.trim();
    setNewKey("");
    setRotating(undefined);
    await act(() => api.rotateProviderConnection(id, key));
  }

  return (
    <Section title="Connections">
      {items && items.length === 0 && <Empty>No provider connected yet.</Empty>}
      {items && items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Provider</th>
              <th>Owner</th>
              <th>Key</th>
              <th>Status</th>
              <th>Last test</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((c) => {
              const editable = canConnect && (c.owner.type === "user" || canManage);
              return (
                <tr key={c.id}>
                  <td>{c.label}</td>
                  <td>{catalog?.find((p) => p.id === c.provider)?.name ?? c.provider}</td>
                  <td>{ownerText(c.owner)}</td>
                  <td className="mono">{c.keyHint ?? "-"}</td>
                  <td>
                    <StatusBadge status={c.status} />
                  </td>
                  <td>
                    {c.lastTest ? (
                      <>
                        {c.lastTest.ok ? "OK" : `Failed (${c.lastTest.code ?? "error"})`}{" "}
                        <span className="muted">{formatDate(c.lastTest.at)}</span>
                        {c.lastTest.message && <div className="muted">{c.lastTest.message}</div>}
                      </>
                    ) : (
                      <span className="muted">Not tested</span>
                    )}
                  </td>
                  <td>
                    {editable && rotating !== c.id && (
                      <div className="row">
                        <button
                          type="button"
                          className="secondary small"
                          disabled={testing === c.id}
                          onClick={() => test(c.id)}
                        >
                          {testing === c.id ? "Testing..." : "Test"}
                        </button>
                        <button type="button" className="secondary small" onClick={() => setRotating(c.id)}>
                          Replace key
                        </button>
                        <button
                          type="button"
                          className="danger small"
                          onClick={() => {
                            if (
                              window.confirm(`Remove "${c.label}"? Model choices using it are removed too.`)
                            ) {
                              void act(() => api.deleteProviderConnection(c.id));
                            }
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    )}
                    {rotating === c.id && (
                      <form className="row" onSubmit={(e) => rotate(e, c.id)} autoComplete="off">
                        <input
                          required
                          type="password"
                          autoComplete="new-password"
                          spellCheck={false}
                          minLength={8}
                          placeholder="New API key"
                          value={newKey}
                          onChange={(e) => setNewKey(e.target.value)}
                        />
                        <button type="submit" className="small">
                          Save
                        </button>
                        <button
                          type="button"
                          className="secondary small"
                          onClick={() => {
                            setNewKey("");
                            setRotating(undefined);
                          }}
                        >
                          Cancel
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="muted">
        Test sends one tiny prompt to the provider with the cheapest model of the catalog.
      </p>
    </Section>
  );
}

function Preferences({
  items,
  connections,
  catalog,
  canManage,
  canConnect,
  act,
}: {
  items?: ModelPreference[];
  connections: ProviderConnection[];
  catalog?: ProviderCatalogEntry[];
  canManage: boolean;
  canConnect: boolean;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [scope, setScope] = useState<"workspace" | "personal">(canManage ? "workspace" : "personal");
  const [stage, setStage] = useState("default");
  const [connectionId, setConnectionId] = useState("");
  const [modelId, setModelId] = useState("");
  const [fallbackConnectionId, setFallbackConnectionId] = useState("");
  const [fallbackModelId, setFallbackModelId] = useState("");

  // Workspace choices may only use workspace-owned keys; personal choices may use either.
  const usable = connections.filter((c) => scope === "personal" || c.owner.type === "workspace");
  const providerOf = (id: string) => connections.find((c) => c.id === id)?.provider;
  const connectionLabel = (id: string) => connections.find((c) => c.id === id)?.label ?? id;

  async function save(event: FormEvent) {
    event.preventDefault();
    const fallback = fallbackConnectionId && fallbackModelId;
    await act(() =>
      api.saveModelPreference({
        scope,
        stage,
        connectionId,
        modelId,
        allowFallback: Boolean(fallback),
        fallbacks: fallback ? [{ connectionId: fallbackConnectionId, modelId: fallbackModelId }] : [],
      }),
    );
  }

  return (
    <Section title="Model choices">
      {canConnect && (
        <form className="row" onSubmit={save}>
          <select
            aria-label="Applies to"
            value={scope}
            onChange={(e) => {
              // A workspace choice cannot use a personal key, so a scope change starts the choice over.
              setScope(e.target.value as "workspace" | "personal");
              setConnectionId("");
              setModelId("");
              setFallbackConnectionId("");
              setFallbackModelId("");
            }}
          >
            <option value="workspace" disabled={!canManage}>
              Whole workspace
            </option>
            <option value="personal">Only my jobs</option>
          </select>
          <select aria-label="Stage" value={stage} onChange={(e) => setStage(e.target.value)}>
            {Object.entries(STAGES).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <select
            required
            aria-label="Connection"
            value={connectionId}
            onChange={(e) => {
              setConnectionId(e.target.value);
              setModelId("");
            }}
          >
            <option value="">Connection...</option>
            {usable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} ({c.provider})
              </option>
            ))}
          </select>
          <select required aria-label="Model" value={modelId} onChange={(e) => setModelId(e.target.value)}>
            <option value="">Model...</option>
            {modelsOf(catalog, providerOf(connectionId)).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} (${m.cost.input}/${m.cost.output} per M tokens)
              </option>
            ))}
          </select>
          <select
            aria-label="Fallback connection"
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
                  Fallback: {c.label} ({c.provider})
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
              <option value="">Fallback model...</option>
              {modelsOf(catalog, providerOf(fallbackConnectionId)).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
          <button type="submit" disabled={usable.length === 0}>
            Save
          </button>
        </form>
      )}
      <p className="muted">
        A fallback is tried only when the provider itself fails (outage, quota, rejected key) and may bill a
        different account.
      </p>
      {items && items.length === 0 && <Empty>No model chosen; jobs use the Studix default.</Empty>}
      {items && items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Applies to</th>
              <th>Stage</th>
              <th>Model</th>
              <th>Fallback</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td>{p.scope.type === "workspace" ? "Whole workspace" : "Only my jobs"}</td>
                <td>{STAGES[p.stage] ?? p.stage}</td>
                <td className="mono">
                  {p.provider} / {p.modelId}{" "}
                  <span className="muted">via {connectionLabel(p.connectionId)}</span>
                </td>
                <td className="mono">
                  {p.allowFallback && p.fallbacks.length > 0
                    ? p.fallbacks.map((f) => `${f.provider} / ${f.modelId}`).join(", ")
                    : "-"}
                </td>
                <td>
                  {canConnect && (p.scope.type === "user" || canManage) && (
                    <button
                      type="button"
                      className="danger small"
                      onClick={() => act(() => api.deleteModelPreference(p.id))}
                    >
                      Clear
                    </button>
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
