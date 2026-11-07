import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type Me, selectedWorkspace, selectWorkspace } from "./api-client.ts";
import { AccountPage } from "./pages/account-page.tsx";
import { ApiKeysPage } from "./pages/api-keys-page.tsx";
import { AuthPage } from "./pages/auth-page.tsx";
import { ConnectedAppsPage } from "./pages/connected-apps-page.tsx";
import { ConnectorsPage } from "./pages/connectors-page.tsx";
import { CreateVideoPage } from "./pages/create-video-page.tsx";
import { JobDetailPage } from "./pages/job-detail-page.tsx";
import { JobsPage } from "./pages/jobs-page.tsx";
import { OAuthPage, oauthViewFor } from "./pages/oauth-pages.tsx";
import { ProjectDetailPage } from "./pages/project-detail-page.tsx";
import { ProjectReviewPage } from "./pages/project-review-page.tsx";
import { ProjectsPage } from "./pages/projects-page.tsx";
import { ProvidersPage } from "./pages/providers-page.tsx";
import { StorageMediaPage } from "./pages/storage-media-page.tsx";
import { takeSsoError } from "./sso-error.ts";
import { ErrorBanner, Link } from "./ui.tsx";
import { navigate, useHashRoute } from "./use-hash-route.ts";

const NAV = [
  { to: "/projects", label: "Projects" },
  { to: "/jobs", label: "Jobs" },
  { to: "/create", label: "New video" },
  { to: "/api-keys", label: "API keys" },
  { to: "/connectors", label: "Connectors" },
  { to: "/connected-apps", label: "Connected apps" },
  { to: "/providers", label: "AI & Providers" },
  { to: "/storage-media", label: "Storage & Media", operatorOnly: true },
  { to: "/account", label: "Account" },
] as const;

type SessionState = { status: "loading" } | { status: "anonymous" } | { status: "ready"; me: Me };

function Route({ segments, me }: { segments: string[]; me: Me }) {
  const [section, id, view] = segments;
  switch (section) {
    case undefined:
    case "projects":
      if (id && view === "review") return <ProjectReviewPage projectId={id} />;
      return id ? <ProjectDetailPage projectId={id} /> : <ProjectsPage />;
    case "jobs":
      return id ? <JobDetailPage jobId={id} /> : <JobsPage />;
    case "create":
      return <CreateVideoPage />;
    case "api-keys":
      return <ApiKeysPage mcpUrl={me.mcpUrl} />;
    case "connectors":
      return <ConnectorsPage />;
    case "connected-apps":
      return <ConnectedAppsPage />;
    case "providers":
      return <ProvidersPage />;
    case "storage-media":
      return me.role === "operator" ? (
        <StorageMediaPage />
      ) : (
        <p className="muted">Storage &amp; Media settings are managed by the platform operator.</p>
      );
    case "account":
      return <AccountPage email={me.user.email} />;
    default:
      return <p className="muted">Page not found.</p>;
  }
}

export function App() {
  // `/oauth/*` (inbound OAuth authorization) is a real path, not a hash route, and renders without the shell.
  const [oauthView] = useState(() => oauthViewFor(window.location.pathname));
  const segments = useHashRoute();
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  const [error, setError] = useState<unknown>();
  // A failed GitHub/Google redirect comes back as /?error=<code>; read it once on load, drop it on navigation.
  const [ssoError, setSsoError] = useState(takeSsoError);
  const route = segments.join("/");
  const landingRoute = useRef(route);
  useEffect(() => {
    if (route !== landingRoute.current) setSsoError(undefined);
  }, [route]);

  const loadSession = useCallback(async () => {
    setError(undefined);
    try {
      setSession({ status: "ready", me: await api.me() });
    } catch (e) {
      if (e instanceof ApiError && e.status === 403 && selectedWorkspace()) {
        // The remembered workspace is no longer ours (membership removed or another account): fall back.
        selectWorkspace(null);
        return loadSession();
      }
      if (e instanceof ApiError && e.status === 401) setSession({ status: "anonymous" });
      else {
        setError(e);
        setSession({ status: "anonymous" });
      }
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  async function signOut() {
    try {
      await api.signOut();
    } finally {
      selectWorkspace(null);
      setSession({ status: "anonymous" });
      navigate("/projects");
    }
  }

  if (session.status === "loading") return <p className="muted center">Loading...</p>;
  if (oauthView) {
    return (
      <OAuthPage
        view={oauthView}
        me={session.status === "ready" ? session.me : undefined}
        error={error}
        ssoError={ssoError}
        onSignedIn={() => void loadSession()}
      />
    );
  }
  if (session.status === "anonymous") {
    return (
      <>
        <ErrorBanner error={error} />
        <AuthPage onSignedIn={() => void loadSession()} ssoError={ssoError} />
      </>
    );
  }

  const { me } = session;
  const current = segments[0] ?? "projects";
  return (
    <div className="shell">
      <header className="topbar">
        <strong className="brand">Studix</strong>
        <nav>
          {NAV.filter((item) => !("operatorOnly" in item) || me.role === "operator").map((item) => (
            <Link key={item.to} to={item.to} className={current === item.to.slice(1) ? "active" : undefined}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="row">
          {me.workspaces.length > 1 && (
            <select
              aria-label="Workspace"
              value={me.workspace?.id}
              onChange={(e) => {
                selectWorkspace(e.target.value);
                void loadSession();
              }}
            >
              {me.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.organizationName} / {w.name}
                </option>
              ))}
            </select>
          )}
          <span className="muted">{me.user.email}</span>
          <button type="button" className="secondary small" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="content" key={me.workspace?.id}>
        {ssoError && (
          <p className="banner banner-error" role="alert">
            {ssoError}
          </p>
        )}
        <Route segments={segments} me={me} />
      </main>
    </div>
  );
}
