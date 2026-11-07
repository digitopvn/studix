import { type FormEvent, useState } from "react";
import {
  api,
  type ProviderConnection,
  type ProviderConnectionStatus,
  type SubscriptionMethodInfo,
} from "../api-client.ts";
import { ErrorBanner, formatDate, Section, StatusBadge, useAsync } from "../ui.tsx";
import { ClaudeFeaturesSection } from "./claude-features-section.tsx";
import { ProviderModelsSection } from "./provider-models-section.tsx";

const STATUS_LABELS: Record<ProviderConnectionStatus, string> = {
  available: "Available",
  invalid: "Invalid",
  unverified: "Unverified",
};

/**
 * AI provider access. The two Anthropic auth methods stay in separate cards on purpose: an API key is
 * usage-based billing; a Claude subscription is restricted unless the server is self-hosted, where each
 * user connects their own (personal only, run by the Claude Code binary).
 */
export function ProvidersPage() {
  const { data, error, reload } = useAsync(() => api.anthropicProvider());
  const subscription = data?.methods.find(
    (m): m is SubscriptionMethodInfo => m.authMethod === "oauth_subscription",
  );

  return (
    <>
      <ErrorBanner error={error} />
      <ProviderModelsSection />
      {subscription && (
        <SubscriptionCard
          method={subscription}
          connection={data?.connections.find((c) => c.authMethod === "oauth_subscription" && c.ownedByMe)}
          reload={reload}
        />
      )}
      <details className="advanced">
        <summary>Advanced</summary>
        <ClaudeFeaturesSection onChange={reload} />
      </details>
    </>
  );
}

const SUBSCRIPTION_BADGE: Record<SubscriptionMethodInfo["availability"], string> = {
  restricted: "Restricted",
  unavailable: "Unavailable",
  available: "Self-hosted",
};

/**
 * Restricted on hosted servers (no connect control). On a self-hosted server the user pastes the token
 * Claude Code's own `claude setup-token` printed; it is stored for them only and only Claude Code uses it.
 */
function SubscriptionCard({
  method,
  connection,
  reload,
}: {
  method: SubscriptionMethodInfo;
  connection?: ProviderConnection;
  reload: () => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>();

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

  async function connect(event: FormEvent) {
    event.preventDefault();
    const value = token.trim();
    // The token leaves component state as soon as it is sent.
    setToken("");
    await act(() =>
      connection
        ? api.replaceAnthropicKey(connection.id, value)
        : api.connectClaudeSubscription({ token: value }),
    );
  }

  async function disconnect(id: string) {
    if (
      !window.confirm(
        "Disconnect your Claude subscription from Studix? To also revoke the token, sign out of it in Claude Code.",
      )
    ) {
      return;
    }
    await act(() => api.removeAnthropicKey(id));
  }

  return (
    <Section
      title="Claude subscription"
      actions={
        <StatusBadge
          status={method.availability === "available" ? (connection?.status ?? "available") : "restricted"}
          label={
            connection && method.availability === "available"
              ? (STATUS_LABELS[connection.status] ?? connection.status)
              : SUBSCRIPTION_BADGE[method.availability]
          }
        />
      }
    >
      {method.availability === "restricted" ? (
        <p className="muted">
          To use your Claude subscription, run Claude Code yourself and link it with Connect agent (top
          right).
        </p>
      ) : (
        <p className="muted">{method.alternative}</p>
      )}
      {method.availability === "available" && (
        <>
          <p className="muted">
            On your own machine, run <span className="mono">claude setup-token</span>, sign in with your own
            Claude account, and paste the token it prints. Studix runs the official Claude Code program with
            it for jobs you create; it is never shared with other members or used for anyone else's jobs.
          </p>
          {connection && (
            <div className="row">
              <span className="mono">{connection.keyHint ?? "-"}</span>
              <span className="muted">Connected {formatDate(connection.createdAt)}</span>
              {connection.lastTest && !connection.lastTest.ok && connection.lastTest.error && (
                <span className="muted">{connection.lastTest.error.message}</span>
              )}
              <button
                type="button"
                className="ghost-danger small"
                disabled={busy}
                onClick={() => disconnect(connection.id)}
              >
                Disconnect
              </button>
            </div>
          )}
          {method.canConnect && (
            <form className="key-add" onSubmit={connect}>
              <input
                required
                type="password"
                autoComplete="new-password"
                aria-label="Claude Code token"
                placeholder="sk-ant-oat…"
                value={token}
                disabled={busy}
                onChange={(e) => setToken(e.target.value)}
              />
              <button type="submit" disabled={busy}>
                {connection ? "Replace token" : "Connect my subscription"}
              </button>
            </form>
          )}
        </>
      )}
      <ErrorBanner error={actionError} />
      <details className="why">
        <summary>Why</summary>
        <p className="muted">{method.reason}</p>
        {method.references.map((url) => (
          <a key={url} href={url} target="_blank" rel="noreferrer">
            {url.replace(/^https?:\/\//, "")}
          </a>
        ))}
      </details>
    </Section>
  );
}
