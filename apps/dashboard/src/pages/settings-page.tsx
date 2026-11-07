import type { Me } from "../api-client.ts";
import { Link } from "../ui.tsx";
import { AccountPage } from "./account-page.tsx";
import { ApiKeysPage, ConnectAgentCard } from "./api-keys-page.tsx";
import { ConnectedAppsPage } from "./connected-apps-page.tsx";
import { ConnectorsPage } from "./connectors-page.tsx";
import { ProvidersPage } from "./providers-page.tsx";
import { SkillDetailPage, SkillsPage } from "./skills-page.tsx";
import { StorageMediaPage } from "./storage-media-page.tsx";
import { WorkspaceMediaKeysSection } from "./workspace-media-keys-section.tsx";
import { WorkspaceMultixSection } from "./workspace-multix-section.tsx";

/** Workspace owners and admins manage the workspace's storage; platform operators also the platform's. */
export function canManageStorage(me: Me): boolean {
  return me.role === "operator" || me.role === "owner" || me.role === "admin";
}

const SECTIONS = [
  { id: "agents", label: "Agents" },
  { id: "models", label: "Models & keys" },
  { id: "skills", label: "Skills" },
  { id: "media", label: "Media", managersOnly: true },
  { id: "storage", label: "Storage", managersOnly: true },
  { id: "account", label: "Account" },
] as const;

export function SettingsPage({ me, section = "agents", id }: { me: Me; section?: string; id?: string }) {
  const sections = SECTIONS.filter((s) => !("managersOnly" in s) || canManageStorage(me));
  return (
    <div className="settings">
      <nav className="subnav" aria-label="Settings">
        <h1>Settings</h1>
        {sections.map((s) => (
          <Link key={s.id} to={`/settings/${s.id}`} className={s.id === section ? "active" : undefined}>
            {s.label}
          </Link>
        ))}
      </nav>
      <div className="settings-body">{body(me, section, id)}</div>
    </div>
  );
}

function body(me: Me, section: string, id?: string) {
  switch (section) {
    case "agents":
      return (
        <>
          <ConnectAgentCard mcpUrl={me.mcpUrl} />
          <ConnectedAppsPage />
          <details className="advanced">
            <summary>For developers: API keys and tools from other apps</summary>
            <ApiKeysPage />
            <ConnectorsPage />
          </details>
        </>
      );
    case "models":
      return <ProvidersPage />;
    case "skills":
      return id ? <SkillDetailPage skillId={id} /> : <SkillsPage isOperator={me.role === "operator"} />;
    case "media":
      return canManageStorage(me) ? (
        <>
          <WorkspaceMultixSection />
          <WorkspaceMediaKeysSection />
          <StorageMediaPage isOperator={me.role === "operator"} part="media" />
        </>
      ) : (
        <p className="muted">Media settings are managed by the workspace owners and admins.</p>
      );
    case "storage":
      return canManageStorage(me) ? (
        <StorageMediaPage isOperator={me.role === "operator"} part="storage" />
      ) : (
        <p className="muted">Storage settings are managed by the workspace owners and admins.</p>
      );
    case "account":
      return <AccountPage me={me} />;
    default:
      return <p className="muted">Page not found.</p>;
  }
}
