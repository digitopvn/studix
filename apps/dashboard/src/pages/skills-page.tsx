import { type FormEvent, useState } from "react";
import { api, type SkillImportItem, type SkillListItem, type SkillScope } from "../api-client.ts";
import { Empty, ErrorBanner, formatDate, Link, Section, StatusBadge, useAsync } from "../ui.tsx";

const HIGH_RISK_PROMPT =
  "This version is HIGH risk (it runs shell or network code, harvests secrets or hides code). Enable it anyway? Your confirmation is audited.";

function sourceLabel(skill: Pick<SkillListItem, "source">): string {
  return skill.source.kind === "upload"
    ? `Upload${skill.source.fileName ? ` (${skill.source.fileName})` : ""}`
    : `${skill.source.owner}/${skill.source.repo}${skill.source.path ? `/${skill.source.path}` : ""}`;
}

function RiskBadge({ level }: { level: string | null }) {
  if (!level) return <span className="muted">-</span>;
  const status = level === "high" ? "failed" : level === "medium" ? "pending" : "succeeded";
  return <StatusBadge status={status} label={`${level} risk`} />;
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
  const [file, setFile] = useState<File | null>(null);
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

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    await act(async () => {
      const { result } = await api.uploadSkill(file, { scope, activate: true });
      setResults([resultText(result)]);
      setFile(null);
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
    <>
      <Section title="Add skills">
        {isOperator && (
          <label className="row">
            Scope
            <select value={scope} onChange={(e) => setScope(e.target.value as SkillScope)}>
              <option value="workspace">This workspace</option>
              <option value="platform">Platform (every workspace)</option>
            </select>
          </label>
        )}
        <form className="row" onSubmit={importRepo}>
          <input
            required
            type="url"
            placeholder="https://github.com/owner/repo"
            value={repositoryUrl}
            onChange={(e) => setRepositoryUrl(e.target.value)}
          />
          <button type="submit" disabled={busy}>
            Import from GitHub
          </button>
        </form>
        <form className="row" onSubmit={upload}>
          <input
            required
            type="file"
            accept=".zip,application/zip"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <button type="submit" disabled={busy || !file}>
            Upload zip
          </button>
        </form>
        <p className="muted">
          A zip holds SKILL.md at its root or in one top folder. Uploading the same skill name again adds a
          new version. High-risk skills start disabled.
        </p>
        {results.length > 0 && (
          <ul>
            {results.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        <ErrorBanner error={actionError} />
      </Section>
      <Section title="Skills">
        <ErrorBanner error={error} />
        {data && data.items.length === 0 && <Empty>No skills yet.</Empty>}
        {data && data.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Scope</th>
                <th>Source</th>
                <th>Risk</th>
                <th>Status</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link to={`/skills/${s.id}`}>{s.name}</Link>
                  </td>
                  <td>{s.scope}</td>
                  <td>{sourceLabel(s)}</td>
                  <td>
                    <RiskBadge level={s.activeRiskLevel} />
                  </td>
                  <td>
                    <StatusBadge
                      status={s.status === "enabled" ? "succeeded" : "canceled"}
                      label={s.status}
                    />
                  </td>
                  <td>{formatDate(s.updatedAt)}</td>
                  <td className="row">
                    {s.manageable && s.status === "enabled" && (
                      <button
                        type="button"
                        className="secondary small"
                        disabled={busy}
                        onClick={() => void act(() => api.disableSkill(s.id))}
                      >
                        Disable
                      </button>
                    )}
                    {s.manageable && s.status === "disabled" && (
                      <button type="button" className="small" disabled={busy} onClick={() => void enable(s)}>
                        Enable
                      </button>
                    )}
                    {s.manageable && (
                      <button
                        type="button"
                        className="secondary small"
                        disabled={busy}
                        onClick={() => void remove(s)}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}

/** One skill: risk report, files, SKILL.md and versions, with activation behind the high-risk gate. */
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
