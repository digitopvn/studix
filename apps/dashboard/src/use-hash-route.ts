import { useCallback, useEffect, useState } from "react";

/**
 * Minimal hash router: `#/jobs/job_123` -> ["jobs", "job_123"]. Hash routes keep the server's SPA fallback
 * trivial and avoid a router dependency for a handful of screens. A `?query` after the path is page state
 * (see `useHashQuery`), not a route segment.
 */
export function currentSegments(): string[] {
  return window.location.hash
    .replace(/^#\/?/, "")
    .split("?")[0]!
    .split("/")
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));
}

export function navigate(path: string): void {
  window.location.hash = path.startsWith("/") ? path : `/${path}`;
}

export function useHashRoute(): string[] {
  const [segments, setSegments] = useState(currentSegments);
  useEffect(() => {
    const update = () => setSegments(currentSegments());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return segments;
}

/** The `?query` part of the hash, e.g. `#/jobs?sort=kind` -> `sort=kind`. */
export function currentHashQuery(): URLSearchParams {
  const hash = window.location.hash;
  const at = hash.indexOf("?");
  return new URLSearchParams(at === -1 ? "" : hash.slice(at + 1));
}

/** Hash query state that survives reloads and shared links; `set` replaces it on the current path. */
export function useHashQuery(): [URLSearchParams, (next: URLSearchParams) => void] {
  const [query, setQuery] = useState(currentHashQuery);
  useEffect(() => {
    const update = () => setQuery(currentHashQuery());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const set = useCallback((next: URLSearchParams) => {
    const path = window.location.hash.replace(/^#/, "").split("?")[0] || "/";
    const qs = next.toString();
    window.history.replaceState(null, "", `#${path}${qs ? `?${qs}` : ""}`);
    setQuery(new URLSearchParams(next));
  }, []);
  return [query, set];
}
