import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { api, type Me, type OAuthRedirect } from "../api-client.ts";
import { ErrorBanner, useAsync } from "../ui.tsx";
import { AuthPage } from "./auth-page.tsx";

/**
 * Pages of the inbound OAuth 2.1 flow (an MCP client such as a Claude or ChatGPT connector asks for access).
 * Better Auth sends the browser to `/oauth/<view>?<signed query>`; the query is passed back verbatim.
 */
export type OAuthView = "login" | "workspace" | "consent";

const VIEWS: Record<string, OAuthView> = {
  "/oauth/login": "login",
  "/oauth/workspace": "workspace",
  "/oauth/consent": "consent",
};

/** `/oauth/consent` -> "consent"; another `/oauth/*` path -> "unknown"; anything else -> undefined. */
export function oauthViewFor(pathname: string): OAuthView | "unknown" | undefined {
  if (!pathname.startsWith("/oauth/")) return undefined;
  return VIEWS[pathname.replace(/\/+$/, "")] ?? "unknown";
}

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  "studix:read": "View projects, jobs, assets and imported skills in the selected workspace",
  "studix:write":
    "Create and edit projects, request renders, cancel or retry jobs, upload assets and import skills from public GitHub repositories (never approve or publish)",
  offline_access: "Stay connected without asking you again",
};

/** Plain-language meaning of an OAuth scope; unknown scopes return their raw name. */
export function scopeDescription(scope: string): string {
  return SCOPE_DESCRIPTIONS[scope] ?? scope;
}

/** Space-separated `scope` parameter of an OAuth query string, as a list. */
export function requestedScopes(search: string): string[] {
  return (new URLSearchParams(search).get("scope") ?? "").split(" ").filter(Boolean);
}

/** The signed query of the current page without the leading `?`, as the Better Auth endpoints expect it. */
function oauthQuery(): string {
  return window.location.search.slice(1);
}

async function follow(step: Promise<OAuthRedirect>): Promise<void> {
  const { url } = await step;
  if (typeof url !== "string" || !url)
    throw new Error("The server did not say where to continue. Try again.");
  window.location.assign(url);
}

function OAuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="auth">
      <div className="card auth-card oauth-card">
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

/** Name and homepage of the requesting client; falls back to the raw client_id when the lookup fails. */
function ClientSummary() {
  const clientId = new URLSearchParams(window.location.search).get("client_id") ?? "";
  // Logos are skipped on purpose: the dashboard CSP only allows same-origin images.
  const client = useAsync(
    () => (clientId ? api.oauthClient(clientId) : Promise.resolve(undefined)),
    [clientId],
  );
  const name = client.data?.client_name || clientId || "An unknown application";
  const uri = client.data?.client_uri;
  return (
    <div className="oauth-client">
      <strong>{name}</strong>
      {uri && <span className="muted mono">{uri}</span>}
    </div>
  );
}

/** Signed in: hand the flow back to Better Auth, which redirects to the next step. */
function ResumeAuthorization() {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    window.location.assign(`/api/auth/oauth2/authorize${window.location.search}`);
  }, []);
  return <p className="muted center">Redirecting...</p>;
}

function WorkspacePicker({ me }: { me: Me }) {
  const { workspaces } = me;
  const initial = workspaces.find((w) => w.id === me.workspace?.id)?.id ?? workspaces[0]?.id ?? "";
  const [workspaceId, setWorkspaceId] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!workspaceId) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.selectOAuthWorkspace(workspaceId);
      await follow(api.continueOAuth(oauthQuery()));
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <OAuthCard title="Choose a workspace">
      <ClientSummary />
      <p className="muted">Signed in as {me.user.email}.</p>
      {workspaces.length === 0 ? (
        <p className="muted">You are not a member of any workspace, so there is nothing to authorize.</p>
      ) : (
        <form className="auth-card" onSubmit={submit} aria-busy={busy}>
          <fieldset className="oauth-choices" disabled={busy}>
            <legend>Authorize access to which workspace?</legend>
            {workspaces.map((w) => (
              <label key={w.id} className="oauth-choice">
                <input
                  type="radio"
                  name="workspace"
                  value={w.id}
                  checked={workspaceId === w.id}
                  onChange={() => setWorkspaceId(w.id)}
                />
                <span>
                  {w.organizationName} / {w.name} <span className="muted">({w.role})</span>
                </span>
              </label>
            ))}
          </fieldset>
          <ErrorBanner error={error} />
          <button type="submit" disabled={busy || !workspaceId}>
            {busy ? "Please wait..." : "Continue"}
          </button>
        </form>
      )}
    </OAuthCard>
  );
}

function ConsentForm({ me }: { me: Me }) {
  const scopes = requestedScopes(window.location.search);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function decide(accept: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      await follow(api.decideOAuthConsent(accept, oauthQuery()));
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <OAuthCard title="Authorize access">
      <ClientSummary />
      <p>This app wants access to your Studix account ({me.user.email}). It will be able to:</p>
      {scopes.length === 0 ? (
        <p className="muted">No specific permissions were requested.</p>
      ) : (
        <ul className="list" aria-label="Requested permissions">
          {scopes.map((scope) => (
            <li key={scope}>
              <code>{scope}</code>
              {scopeDescription(scope) !== scope && <div>{scopeDescription(scope)}</div>}
            </li>
          ))}
        </ul>
      )}
      <p className="banner">
        The app acts only in the workspace you selected, and never with more than your own role there.
      </p>
      <ErrorBanner error={error} />
      <div className="row" aria-busy={busy}>
        <button type="button" disabled={busy} onClick={() => void decide(true)}>
          {busy ? "Please wait..." : "Allow"}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void decide(false)}>
          Deny
        </button>
      </div>
    </OAuthCard>
  );
}

/**
 * Entry point for `/oauth/*`, rendered without the dashboard shell. Anonymous visitors sign in first and
 * come back to the same URL (SSO included); then each view continues the authorization.
 */
export function OAuthPage({
  view,
  me,
  error,
  ssoError,
  onSignedIn,
}: {
  view: OAuthView | "unknown";
  me?: Me;
  error?: unknown;
  ssoError?: string;
  onSignedIn: () => void;
}) {
  if (view === "unknown") {
    return (
      <OAuthCard title="Studix">
        <p className="muted">
          This authorization link is not valid. Start the connection again from your app.
        </p>
      </OAuthCard>
    );
  }
  if (!me) {
    return (
      <>
        <ErrorBanner error={error} />
        <AuthPage
          onSignedIn={onSignedIn}
          ssoError={ssoError}
          returnTo={window.location.pathname + window.location.search}
        />
      </>
    );
  }
  switch (view) {
    case "login":
      return <ResumeAuthorization />;
    case "workspace":
      return <WorkspacePicker me={me} />;
    case "consent":
      return <ConsentForm me={me} />;
  }
}
