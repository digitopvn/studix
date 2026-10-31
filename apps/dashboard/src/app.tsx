import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type Me, selectedWorkspace, selectWorkspace } from "./api-client.ts";
import { AiModelsPage } from "./pages/ai-models-page.tsx";
import { ApiKeysPage } from "./pages/api-keys-page.tsx";
import { AuthPage } from "./pages/auth-page.tsx";
import { ConnectorsPage } from "./pages/connectors-page.tsx";
import { CreateVideoPage } from "./pages/create-video-page.tsx";
import { JobDetailPage } from "./pages/job-detail-page.tsx";
import { JobsPage } from "./pages/jobs-page.tsx";
import { ProjectDetailPage } from "./pages/project-detail-page.tsx";
import { ProjectsPage } from "./pages/projects-page.tsx";
import { ErrorBanner, Link } from "./ui.tsx";
import { navigate, useHashRoute } from "./use-hash-route.ts";

const NAV = [
  { to: "/projects", label: "Projects" },
  { to: "/jobs", label: "Jobs" },
  { to: "/create", label: "New video" },
  { to: "/api-keys", label: "API keys" },
  { to: "/connectors", label: "Connectors" },
  { to: "/ai-models", label: "AI & Models" },
] as const;

type SessionState = { status: "loading" } | { status: "anonymous" } | { status: "ready"; me: Me };

function Route({ segments, me }: { segments: string[]; me: Me }) {
  const [section, id] = segments;
  switch (section) {
    case undefined:
    case "projects":
      return id ? <ProjectDetailPage projectId={id} /> : <ProjectsPage />;
    case "jobs":
      return id ? <JobDetailPage jobId={id} /> : <JobsPage />;
    case "create":
      return <CreateVideoPage />;
    case "api-keys":
      return <ApiKeysPage mcpUrl={me.mcpUrl} />;
    case "connectors":
      return <ConnectorsPage />;
    case "ai-models":
      return <AiModelsPage role={me.role} />;
    default:
      return <p className="muted">Page not found.</p>;
  }
}

export function App() {
  const segments = useHashRoute();
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  const [error, setError] = useState<unknown>();

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
  if (session.status === "anonymous") {
    return (
      <>
        <ErrorBanner error={error} />
        <AuthPage onSignedIn={() => void loadSession()} />
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
          {NAV.map((item) => (
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
        <Route segments={segments} me={me} />
      </main>
    </div>
  );
}
