import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type Me, selectedWorkspace, selectWorkspace } from "./api-client.ts";
import { AgentChatPage } from "./pages/agent-chat-page.tsx";
import { AuthPage } from "./pages/auth-page.tsx";
import { CreateVideoPage } from "./pages/create-video-page.tsx";
import { JobDetailPage } from "./pages/job-detail-page.tsx";
import { JobsPage } from "./pages/jobs-page.tsx";
import { OAuthPage, oauthViewFor } from "./pages/oauth-pages.tsx";
import { ProjectReviewPage } from "./pages/project-review-page.tsx";
import { ProjectView } from "./pages/project-view/project-view.tsx";
import { ProjectsPage } from "./pages/projects-page.tsx";
import { SettingsPage } from "./pages/settings-page.tsx";
import { ActivitySheet, useRecentJobs } from "./shell/activity-sheet.tsx";
import { ConnectDialog } from "./shell/connect-dialog.tsx";
import { setTheme, storedTheme, type Theme } from "./shell/theme.ts";
import { takeSsoError } from "./sso-error.ts";
import { ErrorBanner, Link } from "./ui.tsx";
import { currentHashQuery, navigate, useHashRoute } from "./use-hash-route.ts";
import { registerWebMcpTools } from "./webmcp.ts";

const NAV = [
  { to: "/", label: "Create", match: ["", "chat", "create"] },
  { to: "/projects", label: "Projects", match: ["projects"] },
  { to: "/settings", label: "Settings", match: ["settings"] },
] as const;

/** Pages that moved into Settings keep their old URLs. */
const MOVED: Record<string, string> = {
  "api-keys": "/settings/agents",
  connectors: "/settings/agents",
  "connected-apps": "/settings/agents",
  providers: "/settings/models",
  skills: "/settings/skills",
  "storage-media": "/settings/storage",
  account: "/settings/account",
};

export function movedPath(segments: string[]): string | undefined {
  const [section, id] = segments;
  const target = section ? MOVED[section] : undefined;
  if (!target) return undefined;
  return section === "skills" && id ? `${target}/${encodeURIComponent(id)}` : target;
}

type SessionState = { status: "loading" } | { status: "anonymous" } | { status: "ready"; me: Me };

function Route({ segments, me }: { segments: string[]; me: Me }) {
  const [section, id, view] = segments;
  switch (section) {
    case undefined:
      return <AgentChatPage />;
    case "chat":
      return <AgentChatPage threadId={id} />;
    case "projects":
      if (id && view === "review") return <ProjectReviewPage projectId={id} />;
      return id ? <ProjectView projectId={id} /> : <ProjectsPage />;
    case "jobs":
    case "activity":
      return id ? <JobDetailPage jobId={id} /> : <JobsPage />;
    case "create":
      return <CreateVideoPage />;
    case "settings":
      return <SettingsPage me={me} section={id} id={view} />;
    default:
      return <p className="muted">Page not found.</p>;
  }
}

function TopBar({
  me,
  current,
  onSignOut,
  onWorkspace,
}: {
  me: Me;
  current: string;
  onSignOut: () => void;
  onWorkspace: () => void;
}) {
  const [theme, setThemeState] = useState<Theme>(storedTheme);
  const [sheet, setSheet] = useState(false);
  const [connect, setConnect] = useState(false);
  const { jobs, running, reload } = useRecentJobs();
  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  }
  const initials = (me.user.name || me.user.email).slice(0, 2).toUpperCase();
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <span className="tally-dot" aria-hidden="true" />
        studix
      </Link>
      <nav className="mainnav" aria-label="Main">
        {NAV.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className={(item.match as readonly string[]).includes(current) ? "active" : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="row topbar-actions">
        <button
          type="button"
          className={`tally-pill${running.length ? " live" : ""}${current === "activity" || current === "jobs" ? " active" : ""}`}
          aria-current={current === "activity" || current === "jobs" ? "page" : undefined}
          onClick={() => setSheet(true)}
          aria-label={`Activity, ${running.length} running`}
        >
          <span className="tally-dot" aria-hidden="true" />
          {running.length ? `${running.length} running` : "Activity"}
        </button>
        <button type="button" className="secondary" onClick={() => setConnect(true)}>
          Connect agent
        </button>
        <button
          type="button"
          className="ghost"
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "Use light theme" : "Use dark theme"}
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>
        <details className="avatar-menu">
          <summary aria-label="Account menu">{initials}</summary>
          <div className="menu">
            <span className="muted">{me.user.email}</span>
            {me.workspaces.length > 1 && (
              <select
                aria-label="Workspace"
                value={me.workspace?.id}
                onChange={(e) => {
                  selectWorkspace(e.target.value);
                  onWorkspace();
                }}
              >
                {me.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.organizationName} / {w.name}
                  </option>
                ))}
              </select>
            )}
            <Link to="/settings/account">Account</Link>
            <button type="button" className="secondary small" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </details>
      </div>
      <ActivitySheet open={sheet} onClose={() => setSheet(false)} jobs={jobs} reload={reload} />
      <ConnectDialog open={connect} onClose={() => setConnect(false)} mcpUrl={me.mcpUrl} />
    </header>
  );
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

  const moved = movedPath(segments);
  useEffect(() => {
    if (!moved) return;
    const query = currentHashQuery().toString();
    window.history.replaceState(null, "", `#${moved}${query ? `?${query}` : ""}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }, [moved]);

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

  // In-browser agents get the Studix tools for the signed-in workspace (WebMCP), and lose them on sign-out.
  const workspaceId = session.status === "ready" ? session.me.workspace?.id : undefined;
  useEffect(() => {
    if (!workspaceId) return;
    let cleanup: (() => void) | undefined;
    let live = true;
    registerWebMcpTools().then(
      (c) => {
        if (live) cleanup = c;
        else c();
      },
      () => undefined,
    );
    return () => {
      live = false;
      cleanup?.();
    };
  }, [workspaceId]);

  async function signOut() {
    try {
      await api.signOut();
    } finally {
      selectWorkspace(null);
      setSession({ status: "anonymous" });
      navigate("/");
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
  return (
    <div className="shell">
      <TopBar
        me={me}
        current={segments[0] ?? ""}
        onSignOut={() => void signOut()}
        onWorkspace={() => void loadSession()}
      />
      <main className="content" key={me.workspace?.id}>
        {ssoError && (
          <p className="banner banner-error" role="alert">
            {ssoError}
          </p>
        )}
        {moved ? null : <Route segments={segments} me={me} />}
      </main>
    </div>
  );
}
