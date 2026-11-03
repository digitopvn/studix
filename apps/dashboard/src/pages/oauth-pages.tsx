import { type ReactNode, useEffect, useState } from "react";
import { api, type Me } from "../api-client.ts";
import { ErrorBanner, useAsync } from "../ui.tsx";
import { AuthPage } from "./auth-page.tsx";

/** The signed authorization query Better Auth appended to this page's URL (no leading `?`). */
function oauthQuery(): string {
  return window.location.search.replace(/^\?/, "");
}

function scopeText(scope: string): string | undefined {
  switch (scope) {
    case "studix:read":
      return "View projects, jobs and renders in the chosen workspace";
    case "studix:write":
      return "Create and edit projects, and start jobs, within your role";
    case "offline_access":
      return "Stay connected without asking you to sign in again";
    default:
      return undefined;
  }
}

/** Navigates the browser to the URL Better Auth returns (another page of ours, or the client's redirect URI). */
function go(url: string) {
  window.location.assign(url);
}

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="auth">
      <div className="card auth-card">
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

function Workspace({ me }: { me: Me }) {
  const [workspaceId, setWorkspaceId] = useState(me.workspace?.id ?? me.workspaces[0]?.id ?? "");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  async function choose() {
    setBusy(true);
    setError(undefined);
    try {
      await api.selectMcpWorkspace(workspaceId);
      go(await api.continueMcpAuthorization(oauthQuery()));
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <Frame title="Choose a workspace">
      <p className="muted">The connecting app will only see the workspace you pick here.</p>
      <select aria-label="Workspace" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
        {me.workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.organizationName} / {w.name}
          </option>
        ))}
      </select>
      <ErrorBanner error={error} />
      <button type="button" disabled={busy || !workspaceId} onClick={() => void choose()}>
        Continue
      </button>
    </Frame>
  );
}

function Consent({ me }: { me: Me }) {
  const params = new URLSearchParams(window.location.search);
  const clientId = params.get("client_id") ?? "";
  const scopes = (params.get("scope") ?? "").split(" ").filter(Boolean);
  // Anyone can register a client, so the one fact the user can check is where the result is sent.
  let returnsTo = "an unknown address";
  try {
    returnsTo = new URL(params.get("redirect_uri") ?? "").origin;
  } catch {}
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  async function decide(accept: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      go(await api.decideMcpConsent(accept, oauthQuery()));
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <Frame title="Allow access to Studix?">
      <p>
        An app identifying itself as <code className="mono">{clientId}</code> wants to use your Studix account
        (<strong>{me.user.email}</strong>). If you allow it, you are sent back to <strong>{returnsTo}</strong>
        . Studix has not verified the app's name or identity.
      </p>
      <p className="muted">Only connect apps you trust. You can revoke access at any time under Account.</p>
      <ul>
        {scopes.map((scope) => (
          <li key={scope}>
            <code>{scope}</code>
            {scopeText(scope) && <span className="muted"> — {scopeText(scope)}</span>}
          </li>
        ))}
      </ul>
      <ErrorBanner error={error} />
      <div className="row">
        <button type="button" disabled={busy} onClick={() => void decide(true)}>
          Allow
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void decide(false)}>
          Deny
        </button>
      </div>
    </Frame>
  );
}

/**
 * The three pages the MCP authorization server sends the browser to: sign-in, workspace choice and consent.
 * They live on real paths (`/oauth/*`) because the signed authorization query rides in the URL.
 */
export function OAuthPages({ step }: { step: string }) {
  const [me, setMe] = useState<Me | null | undefined>();
  const resumeUrl = `/api/auth/oauth2/authorize?${oauthQuery()}`;

  useEffect(() => {
    api.me().then(setMe, () => setMe(null));
  }, []);

  // Signed in on the login step (for example a second tab): carry on with the authorization.
  const resuming = me != null && step !== "workspace" && step !== "consent";
  useEffect(() => {
    if (resuming) go(resumeUrl);
  }, [resuming, resumeUrl]);

  if (me === undefined || resuming) return <p className="muted center">Loading...</p>;
  // Signed out: after signing in (password or SSO) resume at the authorize endpoint with the same signed query.
  if (me === null) return <AuthPage onSignedIn={() => go(resumeUrl)} returnTo={resumeUrl} />;
  return step === "workspace" ? <Workspace me={me} /> : <Consent me={me} />;
}

/** Account-page list of apps the user connected over OAuth, with one-click revoke. */
export function ConnectedAppsSection() {
  const { data, error, reload } = useAsync(() => api.mcpConnections());
  const [actionError, setActionError] = useState<unknown>();

  async function revoke(id: string) {
    if (!window.confirm("Disconnect this app? It loses access immediately.")) return;
    setActionError(undefined);
    try {
      await api.revokeMcpConnection(id);
      reload();
    } catch (e) {
      setActionError(e);
    }
  }

  return (
    <>
      <ErrorBanner error={error} />
      <ErrorBanner error={actionError} />
      {data && data.connections.length === 0 && <p className="muted">No connected apps.</p>}
      {data && data.connections.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>App</th>
              <th>Workspace</th>
              <th>Access</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.connections.map((c) => (
              <tr key={c.id}>
                <td>{c.clientName}</td>
                <td>{c.workspaceName ?? c.workspaceId}</td>
                <td className="mono">{c.scopes.filter((s) => s !== "offline_access").join(" ")}</td>
                <td>
                  <button type="button" className="secondary small" onClick={() => void revoke(c.id)}>
                    Disconnect
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
