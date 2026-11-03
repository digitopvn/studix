import { useState } from "react";
import { api, SSO_LABELS, type SsoProvider } from "../api-client.ts";
import { Empty, ErrorBanner, Section, useAsync } from "../ui.tsx";
import { ConnectedAppsSection } from "./oauth-pages.tsx";

/** Sign-in methods of the signed-in user: link GitHub or Google to the account (same verified email). */
export function AccountPage({ email }: { email: string }) {
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

  return (
    <>
      <Section title="Sign-in methods">
        <ErrorBanner error={error ?? actionError} />
        <p className="muted">
          Link a GitHub or Google account whose verified email is {email} to sign in with it.
        </p>
        {data && data.providers.length === 0 && (
          <Empty>Single sign-on is not configured on this server.</Empty>
        )}
        {data?.providers.map((provider) => (
          <div className="row" key={provider}>
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
      </Section>
      <Section title="Connected apps">
        <p className="muted">Apps such as ChatGPT or Claude that you allowed to use Studix over OAuth.</p>
        <ConnectedAppsSection />
      </Section>
    </>
  );
}
