import { type FormEvent, useState } from "react";
import { api, type SkillImportItem, type SkillListItem, type SkillScope } from "../api-client.ts";
import { Empty, ErrorBanner, formatDate, Link, Section, StatusBadge, useAsync } from "../ui.tsx";

const HIGH_RISK_PROMPT =
  "This version is HIGH risk (it runs shell or network code, harvests secrets or hides code). Enable it anyway? Your confirmation is audited.";

function sourceLabel(skill: Pick<SkillListItem, "source">): string {
  if (skill.source.kind === "default") return "Studix default";
  return skill.source.kind === "upload"
    ? `Upload${skill.source.fileName ? ` (${skill.source.fileName})` : ""}`
    : `${skill.source.owner}/${skill.source.repo}${skill.source.path ? `/${skill.source.path}` : ""}`;
}

const RISK_HELP: Record<string, string> = {
  high: "High risk: it can run commands, reach the internet, read secrets or hide code. Enable only skills you trust.",
  medium: "Medium risk: it does something worth a look, such as running scripts. Check the risk report.",
  low: "Low risk: no risky code was found.",
};

function RiskBadge({ level }: { level: string | null }) {
  if (!level) return <span className="muted">-</span>;
  const status = level === "high" ? "failed" : level === "medium" ? "pending" : "succeeded";
  return (
    <span title={RISK_HELP[level] ?? ""}>
      <StatusBadge status={status} label={`${level.charAt(0).toUpperCase()}${level.slice(1)} risk`} />
    </span>
  );
}

function resultText(item: SkillImportItem): string {
  if (item.error) return `${item.path}: ${item.error.message}`;
  const risk = item.risk ? `, ${item.risk.level} risk` : "";
  const confirm = item.riskConfirmationRequired ? " - needs a high-risk confirmation before use" : "";
  return `${item.name ?? item.path}: ${item.outcome}${risk}${confirm}`;
}

/** Workspace and platform Agent Skills: import from GitHub, upload a zip, review risk, manage versions. */
export function SkillsPage({ isOperator }: { isOperator: boolean }) {
  const { data, error, reload } = useAsync(() => api.skills());
  const [scope, setScope] = useState<SkillScope>("workspace");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const [results, setResults] = useState<string[]>([]);

  async function act(action: () => Promise<unknown>) {
    setActionError(undefined);
    setBusy(true);
    try {
      await action();
      reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  async function importRepo(event: FormEvent) {
    event.preventDefault();
    await act(async () => {
      const { results: items } = await api.importSkills({ repositoryUrl: repositoryUrl.trim(), scope });
      setResults(items.map(resultText));
      setRepositoryUrl("");
    });
  }

  async function upload(file: File) {
    await act(async () => {
      const { result } = await api.uploadSkill(file, { scope, activate: true });
      setResults([resultText(result)]);
    });
  }

  async function enable(skill: SkillListItem) {
    const high = skill.activeRiskLevel === "high";
    if (high && !window.confirm(HIGH_RISK_PROMPT)) return;
    await act(() => api.updateSkill(skill.id, { action: "enable", confirmHighRisk: high }));
  }

  async function remove(skill: SkillListItem) {
    if (!window.confirm(`Delete ${skill.name} with every version and file? This cannot be undone.`)) return;
    await act(() => api.deleteSkill(skill.id));
  }

  return (
    <Section title="Skills">
      <p className="muted">
        Skills teach the Studix agent a style or a workflow. Add one from GitHub or a zip.
      </p>
      <ErrorBanner error={error} />
      {data && data.items.length === 0 && (
        <Empty>No skills yet. A skill teaches the agent something new, such as your brand style guide.</Empty>
      )}
      {data && data.items.length > 0 && (
        <ul className="key-list">
          {data.items.map((s) => (
            <li key={s.id} className="key-row">
              <div className="key-main">
                <div className="key-title">
                  <Link to={`/skills/${s.id}`}>
                    <strong>{s.name}</strong>
                  </Link>
                </div>
                <div className="key-meta">
                  <span>{s.scope === "platform" ? "Every workspace" : "This workspace"}</span>
                  <span>{sourceLabel(s)}</span>
                  <span>Updated {formatDate(s.updatedAt)}</span>
                </div>
              </div>
              <div className="key-state">
                <RiskBadge level={s.activeRiskLevel} />
                <StatusBadge
                  status={s.status === "enabled" && !s.turnedOffHere ? "succeeded" : "canceled"}
                  label={s.status !== "enabled" ? "Off" : s.turnedOffHere ? "Off here" : "On"}
                />
              </div>
              {s.scope === "platform" && s.status === "enabled" && (
                <div className="key-actions">
                  <button
                    type="button"
                    className={s.turnedOffHere ? "small" : "secondary small"}
                    disabled={busy}
                    title="Only this workspace; other workspaces keep it"
                    onClick={() =>
                      void act(() =>
                        s.turnedOffHere
                          ? api.updateSkill(s.id, { action: "enable", workspaceOnly: true })
                          : api.disableSkill(s.id, { workspaceOnly: true }),
                      )
                    }
                  >
                    {s.turnedOffHere ? "Turn on here" : "Turn off here"}
                  </button>
                </div>
              )}
              {s.manageable && (
                <div className="key-actions">
                  {s.status === "enabled" ? (
                    <button
                      type="button"
                      className="secondary small"
                      disabled={busy}
                      onClick={() => void act(() => api.disableSkill(s.id))}
                    >
                      Disable
                    </button>
                  ) : (
                    <button type="button" className="small" disabled={busy} onClick={() => void enable(s)}>
                      Enable
                    </button>
                  )}
                  <button
                    type="button"
                    className="ghost-danger small"
                    disabled={busy}
                    onClick={() => void remove(s)}
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {data?.items.some((s) => s.activeRiskLevel === "high") && (
        <p className="muted small-text">{RISK_HELP.high}</p>
      )}
      <form className="key-add" onSubmit={importRepo}>
        <input
          required
          type="url"
          aria-label="GitHub repository URL"
          placeholder="GitHub link to a skill"
          value={repositoryUrl}
          onChange={(e) => setRepositoryUrl(e.target.value)}
        />
        {isOperator && (
          <select
            aria-label="Who can use it"
            value={scope}
            onChange={(e) => setScope(e.target.value as SkillScope)}
          >
            <option value="workspace">This workspace</option>
            <option value="platform">Every workspace</option>
          </select>
        )}
        <button type="submit" disabled={busy}>
          Import
        </button>
        <label className={`button secondary${busy ? " disabled" : ""}`}>
          Upload zip
          <input
            type="file"
            hidden
            disabled={busy}
            accept=".zip,application/zip"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void upload(file);
            }}
          />
        </label>
      </form>
      <details className="why">
        <summary>What a skill zip holds</summary>
        <p className="muted">
          SKILL.md at its root or in one top folder. The same name again adds a new version. High-risk skills
          start disabled.
        </p>
      </details>
      {results.length > 0 && (
        <ul>
          {results.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <ErrorBanner error={actionError} />
    </Section>
  );
}

export function SkillDetailPage({ skillId }: { skillId: string }) {
  const [versionId, setVersionId] = useState<string>();
  const { data, error, reload } = useAsync(() => api.skill(skillId, versionId), [skillId, versionId]);
  const [actionError, setActionError] = useState<unknown>();

  async function act(action: () => Promise<unknown>) {
    setActionError(undefined);
    try {
      await action();
      reload();
    } catch (e) {
      setActionError(e);
    }
  }

  async function activate(id: string, high: boolean) {
    if (high && !window.confirm(HIGH_RISK_PROMPT)) return;
    await act(async () => {
      await api.updateSkill(skillId, { action: "activate", versionId: id, confirmHighRisk: high });
      setVersionId(undefined);
    });
  }

  if (!data) return <ErrorBanner error={error} />;
  const { skill, risk } = data;
  return (
    <>
      <p>
        <Link to="/skills">Back to skills</Link>
      </p>
      <Section title={skill.name}>
        <p>{skill.description}</p>
        <p className="muted">
          {skill.scope} skill from {sourceLabel(skill)}; license {data.license.status}. Skill text is
          untrusted third-party content.
        </p>
        <ErrorBanner error={error ?? actionError} />
      </Section>
      <Section title="Risk report" actions={<RiskBadge level={risk.level} />}>
        {risk.findings.length === 0 && <Empty>No findings.</Empty>}
        {risk.findings.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Severity</th>
                <th>Rule</th>
                <th>File</th>
                <th>Excerpt</th>
              </tr>
            </thead>
            <tbody>
              {risk.findings.map((f) => (
                <tr key={`${f.rule}:${f.path}:${f.line ?? 0}:${f.excerpt}`}>
                  <td>
                    <RiskBadge level={f.severity} />
                  </td>
                  <td>{f.rule}</td>
                  <td>
                    {f.path}
                    {f.line ? `:${f.line}` : ""}
                  </td>
                  <td>
                    <code>{f.excerpt}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {risk.truncated && <p className="muted">More findings were cut from the report.</p>}
      </Section>
      {data.versions && (
        <Section title="Versions">
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Risk</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.versions.map((v) => (
                <tr key={v.id}>
                  <td>
                    <button type="button" className="secondary small" onClick={() => setVersionId(v.id)}>
                      {v.id}
                    </button>
                    {v.active ? " (active)" : ""}
                  </td>
                  <td>
                    <RiskBadge level={v.riskLevel} />
                  </td>
                  <td>{formatDate(v.createdAt)}</td>
                  <td>
                    {skill.manageable && !v.active && (
                      <button
                        type="button"
                        className="small"
                        onClick={() => void activate(v.id, v.riskLevel === "high")}
                      >
                        Activate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      <Section title={`Files (${data.files.length})`}>
        <ul>
          {data.files.map((f) => (
            <li key={f.path}>
              {f.path}{" "}
              <span className="muted">
                {f.bytes} B{f.binary ? ", binary" : ""}
                {f.executable ? ", executable" : ""}
              </span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title={data.content.path}>
        {data.content.binary ? <Empty>Binary file.</Empty> : <pre>{data.content.text}</pre>}
      </Section>
    </>
  );
}
