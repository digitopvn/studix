import { type FormEvent, useState } from "react";
import {
  type ApiKeyMethodInfo,
  api,
  type ProviderConnection,
  type ProviderConnectionStatus,
  type SubscriptionMethodInfo,
} from "../api-client.ts";
import { Empty, ErrorBanner, formatDate, Section, StatusBadge, useAsync } from "../ui.tsx";
import { ProviderModelsSection } from "./provider-models-section.tsx";

type Owner = ProviderConnection["owner"];

const STATUS_LABELS: Record<ProviderConnectionStatus, string> = {
  available: "Available",
  invalid: "Invalid",
  unverified: "Unverified",
};

/**
 * AI provider access. The two Anthropic auth methods stay in separate cards on purpose: an API key is
 * usage-based billing that Studix can use; a Claude subscription (OAuth) is informational only.
 */
export function ProvidersPage() {
  const { data, error, reload } = useAsync(() => api.anthropicProvider());
  const apiKeyMethod = data?.methods.find((m): m is ApiKeyMethodInfo => m.authMethod === "api_key");
  const subscription = data?.methods.find(
    (m): m is SubscriptionMethodInfo => m.authMethod === "oauth_subscription",
  );

  return (
    <>
      <ErrorBanner error={error} />
      {data && (
        <ApiKeyCard
          connections={data.connections}
          canAddWorkspace={apiKeyMethod?.canAddWorkspaceKey ?? false}
          canAddPersonal={apiKeyMethod?.canAddPersonalKey ?? false}
          unavailableReason={
            apiKeyMethod?.availability === "unavailable"
              ? (apiKeyMethod.reason ?? "API keys cannot be stored right now.")
              : undefined
          }
          reload={reload}
        />
      )}
      {subscription && <SubscriptionCard method={subscription} />}
      <ProviderModelsSection />
    </>
  );
}

function ApiKeyCard({
  connections,
  canAddWorkspace,
  canAddPersonal,
  unavailableReason,
  reload,
}: {
  connections: ProviderConnection[];
  canAddWorkspace: boolean;
  canAddPersonal: boolean;
  unavailableReason?: string;
  reload: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [owner, setOwner] = useState<Owner>(canAddPersonal ? "user" : "workspace");
  const [label, setLabel] = useState("");
  const [replacing, setReplacing] = useState<{ id: string; apiKey: string }>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const disabled = busy || unavailableReason !== undefined;

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

  async function add(event: FormEvent) {
    event.preventDefault();
    const key = apiKey.trim();
    // The secret leaves component state as soon as it is sent, whether or not Anthropic accepts it.
    setApiKey("");
    await act(async () => {
      await api.addAnthropicKey({ owner, apiKey: key, label: label.trim() || undefined });
      setLabel("");
    });
  }

  async function replace(event: FormEvent) {
    event.preventDefault();
    if (!replacing) return;
    const { id, apiKey: key } = replacing;
    setReplacing({ id, apiKey: "" });
    await act(async () => {
      await api.replaceAnthropicKey(id, key.trim());
      setReplacing(undefined);
    });
  }

  async function remove(id: string) {
    if (
      !window.confirm(
        "Remove this key from Studix? It is not revoked at Anthropic; revoke it in Claude Console if it should stop working.",
      )
    ) {
      return;
    }
    await act(() => api.removeAnthropicKey(id));
  }

  return (
    <Section title="Anthropic API key · Pay as you go (usage-based)">
      <p className="muted">
        Studix calls Claude with an Anthropic Console API key. Usage is billed per token to the key's
        Anthropic organization, separately from any Claude Pro, Max, Team or Enterprise subscription. Monthly
        API credits that some plans include apply to Console API keys (this method), not to subscription
        sign-in (OAuth).
      </p>
      {unavailableReason && <p className="banner banner-error">{unavailableReason}</p>}
      {(canAddWorkspace || canAddPersonal) && (
        <form className="row" onSubmit={add}>
          <input
            required
            type="password"
            autoComplete="new-password"
            aria-label="Anthropic API key"
            placeholder="sk-ant-…"
            value={apiKey}
            disabled={disabled}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <select
            aria-label="Key owner"
            value={owner}
            disabled={disabled}
            onChange={(e) => setOwner(e.target.value as Owner)}
          >
            {canAddPersonal && <option value="user">Personal key — only you</option>}
            {canAddWorkspace && <option value="workspace">Workspace key — shared with members</option>}
          </select>
          <input
            maxLength={80}
            placeholder="Label (optional)"
            value={label}
            disabled={disabled}
            onChange={(e) => setLabel(e.target.value)}
          />
          <button type="submit" disabled={disabled}>
            Test &amp; save
          </button>
        </form>
      )}
      <ErrorBanner error={actionError} />
      {connections.length === 0 && <Empty>No Anthropic API keys connected.</Empty>}
      {connections.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Owner</th>
              <th>Key</th>
              <th>Status</th>
              <th>Last tested</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {connections.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.label}
                  {c.runtimes.includes("pi") && <div className="muted">Also enabled for Pi</div>}
                </td>
                <td>{c.owner === "workspace" ? "Workspace" : c.ownedByMe ? "Personal (you)" : "Personal"}</td>
                <td className="mono">{c.keyHint ?? "-"}</td>
                <td>
                  <StatusBadge status={c.status} label={STATUS_LABELS[c.status] ?? c.status} />
                </td>
                <td>
                  {c.lastTest ? formatDate(c.lastTest.at) : "Never"}
                  {c.lastTest && !c.lastTest.ok && c.lastTest.error && (
                    <div className="muted">
                      {c.lastTest.error.message}
                      {c.lastTest.error.suggestedAction && ` ${c.lastTest.error.suggestedAction}`}
                    </div>
                  )}
                </td>
                <td>
                  {c.canManage && replacing?.id !== c.id && (
                    <div className="row">
                      <button
                        type="button"
                        className="secondary small"
                        disabled={busy}
                        onClick={() => act(() => api.testAnthropicKey(c.id))}
                      >
                        Test connection
                      </button>
                      <button
                        type="button"
                        className="secondary small"
                        disabled={disabled}
                        onClick={() => setReplacing({ id: c.id, apiKey: "" })}
                      >
                        Replace key
                      </button>
                      <button
                        type="button"
                        className="danger small"
                        disabled={busy}
                        onClick={() => remove(c.id)}
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
                        aria-label="New Anthropic API key"
                        placeholder="sk-ant-…"
                        value={replacing.apiKey}
                        disabled={disabled}
                        onChange={(e) => setReplacing({ id: c.id, apiKey: e.target.value })}
                      />
                      <button type="submit" className="small" disabled={disabled}>
                        Test &amp; save
                      </button>
                      <button
                        type="button"
                        className="secondary small"
                        disabled={busy}
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

/** Informational only: Studix cannot sign in with a Claude subscription, so there is no connect control. */
function SubscriptionCard({ method }: { method: SubscriptionMethodInfo }) {
  return (
    <Section
      title="Claude subscription (OAuth)"
      actions={<StatusBadge status="restricted" label="Restricted" />}
    >
      <p>{method.reason}</p>
      <p className="muted">{method.alternative}</p>
      <p className="muted">
        To use a Claude subscription, run Claude Code on your own machine and add Studix as an MCP server (see
        API keys).
      </p>
      {method.references.length > 0 && (
        <ul>
          {method.references.map((url) => (
            <li key={url}>
              <a href={url} target="_blank" rel="noreferrer">
                {url}
              </a>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
