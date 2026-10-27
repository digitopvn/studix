import { type FormEvent, useState } from "react";
import { api } from "../api-client.ts";
import { ErrorBanner } from "../ui.tsx";

/** Email/password sign-in and sign-up (Better Auth). Sign-up provisions a personal workspace server-side. */
export function AuthPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>();
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
