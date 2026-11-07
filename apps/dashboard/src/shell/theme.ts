export type Theme = "dark" | "light";

const KEY = "studix-theme";

/** Dark is the default: video is judged in a dim room. Storage can be blocked, so reads never throw. */
export function storedTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // The choice still applies to this page view.
  }
}

export function applyStoredTheme(): void {
  document.documentElement.dataset.theme = storedTheme();
}
