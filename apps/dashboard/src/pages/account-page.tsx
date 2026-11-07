import { useState } from "react";
import { api, type Me, SSO_LABELS, type SsoProvider } from "../api-client.ts";
import { ErrorBanner, Section, useAsync } from "../ui.tsx";

const ROLE_LABELS: Record<string, string> = {
  operator: "Platform operator",
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

/** Who is signed in, which workspace they are in, and (when the server offers it) GitHub/Google sign-in. */
export function AccountPage({ me }: { me: Me }) {
  const { data, error } = useAsync(async () => {
    const [{ providers }, accounts] = await Promise.all([api.ssoProviders(), api.linkedAccounts()]);
    return { providers, linked: new Set(accounts.map((a) => a.providerId)) };
  });
  const [actionError, setActionError] = useState<unknown>();

  async function link(provider: SsoProvider) {
    setActionError(undefined);
    try {
      await api.linkProvider(provider);
    } catch (e) {
      setActionError(e);
    }
  }

  const rows: [string, string][] = [
    ["Name", me.user.name || "-"],
    ["Email", me.user.email],
    ["Workspace", me.workspace?.name ?? "-"],
    ["Organization", me.organization?.name ?? "-"],
    ["Your role", ROLE_LABELS[me.role] ?? me.role],
  ];

  return (
    <>
      <Section title="Profile">
        <div className="key-list">
          {rows.map(([label, value]) => (
            <div className="key-row" key={label}>
              <span className="muted">{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
        {me.workspaces.length > 1 && (
          <p className="muted">
            You belong to {me.workspaces.length} workspaces. Switch from the account menu (your initials, top
            right).
          </p>
        )}
      </Section>
      {(error || actionError || (data && data.providers.length > 0)) && (
        <Section title="Sign-in methods">
          <ErrorBanner error={error ?? actionError} />
          <p className="muted">Sign in with GitHub or Google when its verified email is {me.user.email}.</p>
          <div className="key-list">
            {data?.providers.map((provider) => (
              <div className="key-row" key={provider}>
                <strong>{SSO_LABELS[provider]}</strong>
                {data.linked.has(provider) ? (
                  <span className="muted">Linked</span>
                ) : (
                  <button type="button" className="secondary small" onClick={() => void link(provider)}>
                    Link {SSO_LABELS[provider]}
                  </button>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}
