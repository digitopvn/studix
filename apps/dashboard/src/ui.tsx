import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ApiError } from "./api-client.ts";

/** Load data on mount and on `reload()`; keeps the last good value while refreshing. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: callers pass the inputs `load` depends on.
  useEffect(() => {
    let active = true;
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => active && setState({ data, loading: false }),
      (error: unknown) => active && setState((s) => ({ data: s.data, error, loading: false })),
    );
    return () => {
      active = false;
    };
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    return error.suggestedAction ? `${error.message} ${error.suggestedAction}` : error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="banner banner-error" role="alert">
      {errorText(error)}
    </p>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status.replace(/[^a-z_]/g, "")}`}>{status.replace(/_/g, " ")}</span>;
}

export function formatDate(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <a href={`#${to}`} className={className}>
      {children}
    </a>
  );
}

export function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <header className="card-header">
        <h2>{title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted">{children}</p>;
}
