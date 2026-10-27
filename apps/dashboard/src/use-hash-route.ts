import { useEffect, useState } from "react";

/**
 * Minimal hash router: `#/jobs/job_123` -> ["jobs", "job_123"]. Hash routes keep the server's SPA fallback
 * trivial and avoid a router dependency for a handful of screens.
 */
export function currentSegments(): string[] {
  return window.location.hash
    .replace(/^#\/?/, "")
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
