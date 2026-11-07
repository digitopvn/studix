import { useEffect, useState } from "react";
import { api, type Job } from "../api-client.ts";
import { jobTitle, shortError, stepLabel } from "../shell/job-labels.ts";
import { Empty, ErrorBanner, formatDate, Link, Section, StatusBadge } from "../ui.tsx";
import { useHashQuery } from "../use-hash-route.ts";
import { formatJobAgent, JOB_AGENT_OPTIONS, jobAgentOptionLabel } from "./job-agent.ts";
import {
  clearFilters,
  currentSort,
  dayToInstant,
  hasFilters,
  instantToDay,
  JOB_STATUS_OPTIONS,
  type JobListParam,
  type JobSortField,
  jobListQuery,
  listParam,
  toApiNumber,
  toDisplayNumber,
  toggleSort,
  UNIT_SCALE,
  withList,
  withParam,
} from "./job-list-filters.ts";

type Query = URLSearchParams;

const TABS = [
  { id: "all", label: "All", statuses: [] as string[] },
  { id: "running", label: "Running", statuses: ["queued", "running", "waiting_approval"] },
  { id: "failed", label: "Failed", statuses: ["failed"] },
  { id: "done", label: "Done", statuses: ["succeeded"] },
];
type SetQuery = (next: Query) => void;

export function JobsPage() {
  const [hash, setHash] = useHashQuery();
  const query = jobListQuery(hash);
  const key = query.toString();
  const [items, setItems] = useState<Job[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  // Kinds and stages have no catalog endpoint; offer every value seen so far.
  const [seen, setSeen] = useState<{ kind: Set<string>; stage: Set<string> }>(() => ({
    kind: new Set(),
    stage: new Set(),
  }));

  const remember = (jobs: Job[]) =>
    setSeen((s) => ({
      kind: new Set([...s.kind, ...jobs.map((j) => j.kind)]),
      stage: new Set([...s.stage, ...jobs.flatMap((j) => (j.stage ? [j.stage] : []))]),
    }));

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the serialized query; `tick` reloads.
  useEffect(() => {
    let active = true;
    setLoading(true);
    api.jobs(new URLSearchParams(key)).then(
      (page) => {
        if (!active) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setError(undefined);
        setLoading(false);
        remember(page.items);
      },
      (err: unknown) => {
        if (!active) return;
        setError(err);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [key, tick]);

  const loadMore = () => {
    if (!nextCursor) return;
    setLoading(true);
    api.jobs(new URLSearchParams(key), nextCursor).then(
      (page) => {
        setItems((prev) => [...prev, ...page.items]);
        setNextCursor(page.nextCursor);
        setLoading(false);
        remember(page.items);
      },
      (err: unknown) => {
        setError(err);
        setLoading(false);
      },
    );
  };

  const set: SetQuery = (next) => setHash(jobListQuery(next));
  const sortHeader = (field: JobSortField, label: string, also?: { field: JobSortField; label: string }) => (
    <SortHeader field={field} label={label} also={also} query={query} onChange={set} />
  );

  const table = query.get("view") === "table";
  const statuses = listParam(query, "status");
  const tab = TABS.find((t) => t.statuses.join() === statuses.join())?.id ?? (statuses.length ? "" : "all");
  const toggleView = () => {
    const next = new URLSearchParams(query);
    if (table) next.delete("view");
    else next.set("view", "table");
    set(next);
  };

  return (
    <Section
      title="Activity"
      actions={
        <>
          <div className="segment" role="tablist" aria-label="Status">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => set(withList(query, "status", t.statuses))}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button type="button" className="secondary" onClick={toggleView}>
            {table ? "List view" : "Table view"}
          </button>
          {table && (
            <button
              type="button"
              className="secondary"
              onClick={() => set(clearFilters(query))}
              disabled={!hasFilters(query)}
            >
              Clear filters
            </button>
          )}
          <button
            type="button"
            className="secondary"
            onClick={() => setTick((t) => t + 1)}
            disabled={loading}
          >
            Refresh
          </button>
        </>
      }
    >
      <ErrorBanner error={error} />
      {!table && (
        <ul className="activity-list">
          {items.map((j) => (
            <li key={j.id}>
              <Link to={`/jobs/${j.id}`} className="activity-row">
                <span className="activity-head">
                  <span className="activity-title">{jobTitle(j)}</span>
                  <StatusBadge status={j.status} />
                </span>
                <span className="activity-meta">
                  {stepLabel(j)} · {Math.round((j.progress ?? 0) * 100)}% · {formatJobAgent(j.agent)} · $
                  {((j.spentCents ?? 0) / 100).toFixed(2)} · {formatDate(j.updatedAt)}
                </span>
                {j.status === "failed" && j.error?.message && (
                  <span className="activity-error">{shortError(j.error.message)}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {table && (
        <div className="table-scroll">
          <table className="jobs-table">
            <thead>
              <tr>
                {sortHeader("kind", "Job")}
                {sortHeader("status", "Status")}
                {sortHeader("stage", "Stage")}
                {sortHeader("projectId", "Project")}
                {sortHeader("agent", "Agent", { field: "model", label: "model" })}
                {sortHeader("progress", "Progress")}
                {sortHeader("spentCents", "Spend")}
                {sortHeader("createdAt", "Created")}
                {sortHeader("updatedAt", "Updated")}
              </tr>
              <tr className="filter-row">
                <th>
                  <MultiSelect
                    label="Kind"
                    name="kind"
                    options={[...seen.kind]}
                    query={query}
                    onChange={set}
                  />
                  <TextFilter label="Job id contains" name="id" query={query} onChange={set} />
                </th>
                <th>
                  <MultiSelect
                    label="Status"
                    name="status"
                    options={JOB_STATUS_OPTIONS}
                    query={query}
                    onChange={set}
                  />
                </th>
                <th>
                  <MultiSelect
                    label="Stage"
                    name="stage"
                    options={[...seen.stage]}
                    query={query}
                    onChange={set}
                  />
                </th>
                <th>
                  <TextFilter label="Project id contains" name="project" query={query} onChange={set} />
                </th>
                <th>
                  <MultiSelect
                    label="Runtime"
                    name="agent"
                    options={JOB_AGENT_OPTIONS}
                    optionLabel={jobAgentOptionLabel}
                    query={query}
                    onChange={set}
                  />
                  <TextFilter label="Model contains" name="model" query={query} onChange={set} />
                </th>
                <th>
                  <RangeFilter
                    label="Progress %"
                    min="progressMin"
                    max="progressMax"
                    scale={UNIT_SCALE.progress}
                    integer={false}
                    query={query}
                    onChange={set}
                  />
                </th>
                <th>
                  <RangeFilter
                    label="Spend $"
                    min="spentMin"
                    max="spentMax"
                    scale={UNIT_SCALE.spent}
                    integer
                    query={query}
                    onChange={set}
                  />
                </th>
                <th>
                  <DateFilter
                    label="Created"
                    from="createdFrom"
                    to="createdTo"
                    query={query}
                    onChange={set}
                  />
                </th>
                <th>
                  <DateFilter
                    label="Updated"
                    from="updatedFrom"
                    to="updatedTo"
                    query={query}
                    onChange={set}
                  />
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((j) => (
                <tr key={j.id}>
                  <td>
                    <Link to={`/jobs/${j.id}`}>{j.kind}</Link>
                    <div className="muted mono">{j.id}</div>
                  </td>
                  <td>
                    <StatusBadge status={j.status} />
                  </td>
                  <td>{j.stage ?? "-"}</td>
                  <td>{j.projectId ? <Link to={`/projects/${j.projectId}`}>{j.projectId}</Link> : "-"}</td>
                  <td>{formatJobAgent(j.agent)}</td>
                  <td>{Math.round((j.progress ?? 0) * 100)}%</td>
                  <td>${((j.spentCents ?? 0) / 100).toFixed(2)}</td>
                  <td>{formatDate(j.createdAt)}</td>
                  <td>{formatDate(j.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!loading && !error && items.length === 0 && (
        <Empty>{hasFilters(query) ? "No jobs match these filters." : "No jobs yet."}</Empty>
      )}
      {nextCursor && (
        <button type="button" className="secondary" onClick={loadMore} disabled={loading}>
          Load more
        </button>
      )}
    </Section>
  );
}

/** Column header that sorts by `field`; `also` adds a second sort key in the same column. */
function SortHeader({
  field,
  label,
  also,
  query,
  onChange,
}: {
  field: JobSortField;
  label: string;
  also?: { field: JobSortField; label: string };
  query: Query;
  onChange: SetQuery;
}) {
  const { sort, order } = currentSort(query);
  const active = sort === field || sort === also?.field;
  const button = (f: JobSortField, text: string) => (
    <button
      type="button"
      className={sort === f ? "sort-header active" : "sort-header"}
      title={`Sort by ${text}`}
      onClick={() => onChange(toggleSort(query, f))}
    >
      {text}
      <span aria-hidden="true">{sort === f ? (order === "asc" ? " ▲" : " ▼") : " ↕"}</span>
    </button>
  );
  return (
    <th aria-sort={active ? (order === "asc" ? "ascending" : "descending") : undefined}>
      {button(field, label)}
      {also && <> {button(also.field, also.label)}</>}
    </th>
  );
}

function MultiSelect({
  label,
  name,
  options,
  optionLabel = (value) => value,
  query,
  onChange,
}: {
  label: string;
  name: JobListParam;
  options: readonly string[];
  optionLabel?: (value: string) => string;
  query: Query;
  onChange: SetQuery;
}) {
  const selected = listParam(query, name);
  const all = [...new Set([...options, ...selected])].sort();
  const toggle = (value: string) =>
    onChange(
      withList(
        query,
        name,
        selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value],
      ),
    );
  return (
    <details className="filter-multi">
      <summary aria-label={`${label} filter`}>
        {selected.length ? `${label} (${selected.length})` : label}
      </summary>
      <div className="filter-menu">
        {all.length === 0 && <span className="muted">No values yet</span>}
        {all.map((value) => (
          <label key={value}>
            <input type="checkbox" checked={selected.includes(value)} onChange={() => toggle(value)} />{" "}
            {optionLabel(value)}
          </label>
        ))}
      </div>
    </details>
  );
}

/** Text input that writes to the URL after typing pauses. */
function useDebounced(value: string, commit: (value: string) => void): [string, (value: string) => void] {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `commit` is recreated each render.
  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => commit(draft), 350);
    return () => clearTimeout(timer);
  }, [draft]);
  return [draft, setDraft];
}

function TextFilter({
  label,
  name,
  query,
  onChange,
}: {
  label: string;
  name: JobListParam;
  query: Query;
  onChange: SetQuery;
}) {
  const [draft, setDraft] = useDebounced(query.get(name) ?? "", (v) =>
    onChange(withParam(query, name, v.trim())),
  );
  return (
    <input
      type="search"
      className="filter-input"
      placeholder={label}
      aria-label={label}
      maxLength={100}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
    />
  );
}

function NumberInput({
  label,
  name,
  scale,
  integer,
  query,
  onChange,
}: {
  label: string;
  name: JobListParam;
  scale: number;
  integer: boolean;
  query: Query;
  onChange: SetQuery;
}) {
  const [draft, setDraft] = useDebounced(toDisplayNumber(query.get(name), scale, integer), (v) =>
    onChange(withParam(query, name, toApiNumber(v, scale, integer))),
  );
  return (
    <input
      type="number"
      min={0}
      step="any"
      className="filter-input filter-number"
      placeholder={label}
      aria-label={label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
    />
  );
}

function RangeFilter({
  label,
  min,
  max,
  scale,
  integer,
  query,
  onChange,
}: {
  label: string;
  min: JobListParam;
  max: JobListParam;
  scale: number;
  integer: boolean;
  query: Query;
  onChange: SetQuery;
}) {
  return (
    <div className="filter-range">
      <NumberInput
        label={`${label} min`}
        name={min}
        scale={scale}
        integer={integer}
        query={query}
        onChange={onChange}
      />
      <NumberInput
        label={`${label} max`}
        name={max}
        scale={scale}
        integer={integer}
        query={query}
        onChange={onChange}
      />
    </div>
  );
}

function DateFilter({
  label,
  from,
  to,
  query,
  onChange,
}: {
  label: string;
  from: JobListParam;
  to: JobListParam;
  query: Query;
  onChange: SetQuery;
}) {
  return (
    <div className="filter-range">
      <input
        type="date"
        className="filter-input"
        aria-label={`${label} from`}
        value={instantToDay(query.get(from))}
        onChange={(e) => onChange(withParam(query, from, dayToInstant(e.target.value, "from")))}
      />
      <input
        type="date"
        className="filter-input"
        aria-label={`${label} to`}
        value={instantToDay(query.get(to))}
        onChange={(e) => onChange(withParam(query, to, dayToInstant(e.target.value, "to")))}
      />
    </div>
  );
}
