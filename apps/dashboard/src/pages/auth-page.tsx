import { type FormEvent, useState } from "react";
import { api, SSO_LABELS, type SsoProvider } from "../api-client.ts";
import { ErrorBanner, useAsync } from "../ui.tsx";

/**
 * Email/password sign-in and sign-up plus GitHub/Google SSO (Better Auth). Either way a new user gets a
 * personal workspace server-side. `ssoError` is the message of a failed SSO redirect.
 */
export function AuthPage({
  onSignedIn,
  ssoError,
  returnTo,
}: {
  onSignedIn: () => void;
  ssoError?: string;
  /** Where an SSO redirect lands afterwards (defaults to the dashboard home). */
  returnTo?: string;
}) {
  // Without the list (older server, network) the page still offers email/password.
  const sso = useAsync(() => api.ssoProviders());
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(ssoError ? new Error(ssoError) : undefined);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (mode === "signup")
        await api.signUp(name.trim() || email.split("@")[0] || "Studix user", email, password);
      else await api.signIn(email, password);
      onSignedIn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function signInWith(provider: SsoProvider) {
    setBusy(true);
    setError(undefined);
    try {
      await api.signInWith(provider, returnTo);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  const providers = sso.data?.providers ?? [];

  return (
    <main className="auth">
      <form className="card auth-card" onSubmit={submit}>
        <h1>Studix</h1>
        <p className="muted">
          {mode === "signin" ? "Sign in to your studio." : "Create your studio account."}
        </p>
        {mode === "signup" && (
          <label>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              maxLength={100}
            />
          </label>
        )}
        <label>
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
          />
        </label>
        <ErrorBanner error={error} />
        <button type="submit" disabled={busy}>
          {busy ? "Please wait..." : mode === "signin" ? "Sign in" : "Create account"}
        </button>
        {providers.map((provider) => (
          <button
            key={provider}
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void signInWith(provider)}
          >
            Continue with {SSO_LABELS[provider]}
          </button>
        ))}
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError(undefined);
          }}
        >
          {mode === "signin" ? "No account? Sign up" : "Have an account? Sign in"}
        </button>
      </form>
    </main>
  );
}
