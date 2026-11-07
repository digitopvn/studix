import { useState } from "react";
import { api, type FeatureSwitch, type WorkspaceFeatures } from "../api-client.ts";
import { ErrorBanner, Section, useAsync } from "../ui.tsx";

type FeatureKey = "claudePlanner" | "claudeSubscription";

const FEATURES: { key: FeatureKey; title: string; detail: string }[] = [
  {
    key: "claudePlanner",
    title: "Claude planner",
    detail: "Jobs may select the Claude planner, run on the worker with the job's own Anthropic connection.",
  },
  {
    key: "claudeSubscription",
    title: "Claude subscription",
    detail:
      "Each member may connect their own subscription with `claude setup-token`; only the Claude Code binary uses it.",
  },
];

function sourceNote(feature: FeatureSwitch): string | undefined {
  if (feature.source === "operator") return "On for every workspace by the server configuration.";
  if (!feature.canChange) return "Only the workspace owner can change this.";
  return undefined;
}

/**
 * Self-hosted servers only (STUDIX_SELF_HOSTED): the workspace owner switches the Claude features on here
 * instead of in env. Hidden on a hosted server, where only the operator's env flags apply.
 */
export function ClaudeFeaturesSection({ onChange }: { onChange: () => void }) {
  const { data, error, reload } = useAsync(() => api.workspaceFeatures());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  if (!data?.selfHosted) return error ? <ErrorBanner error={error} /> : null;

  async function toggle(key: FeatureKey, enabled: boolean) {
    setActionError(undefined);
    setBusy(true);
    try {
      await api.updateWorkspaceFeatures({ [key]: enabled });
      reload();
      onChange();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Claude features (self-hosted)">
      <ErrorBanner error={actionError} />
      {FEATURES.map(({ key, title, detail }) => {
        const feature = (data as WorkspaceFeatures)[key];
        const note = sourceNote(feature);
        return (
          <div key={key}>
            <label className="row">
              <input
                type="checkbox"
                checked={feature.enabled}
                disabled={busy || !feature.canChange}
                onChange={(e) => toggle(key, e.target.checked)}
              />
              {title}
            </label>
            <p className="muted">
              {detail}
              {note ? ` ${note}` : ""}
            </p>
          </div>
        );
      })}
    </Section>
  );
}
