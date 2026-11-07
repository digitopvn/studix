import { useRef, useState } from "react";
import { api, type ProjectReview, type ReviewComment } from "../../api-client.ts";
import { CopyForAgent } from "../../copy-for-agent.tsx";
import { ErrorBanner, formatDate, Link, StatusBadge, useAsync } from "../../ui.tsx";
import { navigate } from "../../use-hash-route.ts";
import { AnnotateLayer, imageFileToDataUrl, Marks, Pins, snapshot } from "./annotate-layer.tsx";
import { ProgressPanel } from "./progress-panel.tsx";
import {
  agentBrief,
  blankNote,
  type DraftNote,
  droppedImages,
  feedbackRequest,
  type Intent,
  type Priority,
  seconds,
  shotAt,
  type Tool,
} from "./review-notes.ts";
import "./project-view.css";

const TOOLS: Array<{ id: Tool; label: string }> = [
  { id: "box", label: "Box" },
  { id: "pin", label: "Pin" },
  { id: "pen", label: "Pen" },
  { id: "arrow", label: "Arrow" },
];
const INTENTS: Intent[] = ["change", "fix", "remove", "add", "keep"];
const PRIORITIES: Priority[] = ["must", "should", "nice"];

/** The Studix draft the Create page picks up, so a revision brief starts a new take in one click. */
export const REVISE_DRAFT_KEY = "studix-revise-draft";

function Chips<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="segment" aria-label={label}>
      {options.map((o) => (
        <button key={o} type="button" aria-pressed={value === o} onClick={() => onChange(o)}>
          {o}
        </button>
      ))}
    </fieldset>
  );
}

function NoteEditor({
  note,
  onChange,
  onSave,
  onCancel,
  currentMs,
}: {
  note: DraftNote;
  onChange: (n: DraftNote) => void;
  onSave: () => void;
  onCancel: () => void;
  currentMs: () => number;
}) {
  const [refUrl, setRefUrl] = useState("");
  const [refError, setRefError] = useState<string>();
  const full = note.references.length >= 6;
  function addRef(url: string) {
    onChange({ ...note, references: [...note.references, { url }].slice(0, 6) });
  }
  return (
    <div className="note-editor">
      <div className="row note-when">
        <strong className="mono">
          {seconds(note.frameMs)}
          {note.endMs !== undefined && ` → ${seconds(note.endMs)}`}
        </strong>
        {note.shotId && <span className="muted small-text mono">shot {note.shotId}</span>}
        <button
          type="button"
          className="ghost small"
          onClick={() => {
            const end = currentMs();
            onChange(end > note.frameMs ? { ...note, endMs: end } : { ...note, endMs: undefined });
          }}
        >
          {note.endMs === undefined ? "Set end at playhead" : "Clear range"}
        </button>
      </div>
      <textarea
        rows={3}
        maxLength={1500}
        placeholder="What should change here? Be specific: what, how, and why."
        aria-label="Note"
        value={note.text}
        onChange={(e) => onChange({ ...note, text: e.target.value })}
      />
      <div className="row wrap">
        <Chips
          label="Intent"
          options={INTENTS}
          value={note.intent}
          onChange={(intent) => onChange({ ...note, intent })}
        />
        <Chips
          label="Priority"
          options={PRIORITIES}
          value={note.priority}
          onChange={(priority) => onChange({ ...note, priority })}
        />
      </div>
      <div className="refs">
        <div className="row">
          <input
            type="url"
            placeholder="Reference link (image, video, page)"
            aria-label="Reference link"
            value={refUrl}
            disabled={full}
            onChange={(e) => setRefUrl(e.target.value)}
          />
          <button
            type="button"
            className="secondary small"
            disabled={full || !/^https?:\/\/\S+$/.test(refUrl.trim())}
            onClick={() => {
              addRef(refUrl.trim());
              setRefUrl("");
            }}
          >
            Add
          </button>
          <label className={`secondary small file-button${full ? " disabled" : ""}`}>
            Image…
            <input
              type="file"
              accept="image/*"
              disabled={full}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                const url = await imageFileToDataUrl(file).catch(() => undefined);
                if (url) {
                  setRefError(undefined);
                  addRef(url);
                } else setRefError("That image could not be read or is too large.");
              }}
            />
          </label>
        </div>
        {refError && <p className="small-text danger-text">{refError}</p>}
        {note.references.length > 0 && (
          <ul className="ref-list">
            {note.references.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: references are positional.
              <li key={i}>
                {r.url.startsWith("data:") ? (
                  <img src={r.url} alt={`Reference ${i + 1}`} />
                ) : (
                  <span className="mono">{r.url}</span>
                )}
                <input
                  placeholder="What to take from it"
                  aria-label={`What to take from reference ${i + 1}`}
                  value={r.note ?? ""}
                  maxLength={300}
                  onChange={(e) =>
                    onChange({
                      ...note,
                      references: note.references.map((x, j) =>
                        j === i ? { ...x, note: e.target.value || undefined } : x,
                      ),
                    })
                  }
                />
                <button
                  type="button"
                  className="ghost small"
                  aria-label={`Remove reference ${i + 1}`}
                  onClick={() => onChange({ ...note, references: note.references.filter((_, j) => j !== i) })}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="row">
        <button type="button" onClick={onSave} disabled={!note.text.trim()}>
          Save note
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => onChange({ ...note, region: undefined, pins: [], strokes: [] })}
        >
          Clear marks
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** No take yet: say what the latest run is doing, and where to look when it failed. */
function EmptyPlayer({ jobs }: { jobs: ProjectReview["cost"]["jobs"] }) {
  const last = [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const running = last && ["queued", "running", "waiting"].includes(last.status);
  return (
    <div className="player-empty">
      {last?.status === "failed" ? (
        <>
          <strong>The last run failed before a take was made.</strong>
          <Link to={`/chat/${last.id}`}>See what happened and retry</Link>
        </>
      ) : running ? (
        <>
          <strong>Making your video…</strong>
          <Link to={`/chat/${last.id}`}>Watch progress</Link>
        </>
      ) : (
        <span className="muted">No take yet. The video appears here when the first take is ready.</span>
      )}
    </div>
  );
}

function CommentItem({ c, projectId }: { c: ReviewComment; projectId: string }) {
  const a = c.annotation;
  return (
    <li className="comment">
      <div className="row">
        {a?.priority && <span className={`prio prio-${a.priority}`}>{a.priority}</span>}
        {a?.intent && <span className="muted small-text">{a.intent}</span>}
        {c.atMs !== undefined && <span className="mono small-text">{seconds(c.atMs)}</span>}
        <span className="muted small-text">{formatDate(c.createdAt)}</span>
      </div>
      {c.images ? (
        <img
          className="comment-snap"
          src={`/api/projects/${encodeURIComponent(projectId)}/feedback/${encodeURIComponent(c.id)}/image/0`}
          alt="Marked frame"
          loading="lazy"
        />
      ) : null}
      <p className="prewrap small-text">{c.body}</p>
    </li>
  );
}

function Storyboard({ review, seek }: { review: ProjectReview; seek: (ms: number) => void }) {
  const scenes = review.storyboard?.scenes ?? [];
  if (!scenes.length) return null;
  return (
    <section className="storyboard">
      <h2>Storyboard</h2>
      {scenes.map((scene) => (
        <div key={scene.id} className="scene">
          <div className="row">
            <strong>{scene.title}</strong>
            <span className="muted small-text mono">
              {seconds(scene.startMs)}–{seconds(scene.endMs)}
            </span>
          </div>
          <div className="shot-strip">
            {scene.shots.map((shot) => (
              <button
                key={shot.id}
                type="button"
                className={`shot-card render-${shot.render}`}
                onClick={() => seek(shot.startMs)}
                title={
                  shot.render === "rendered"
                    ? "Jump to this shot"
                    : `Shot is ${shot.render.replace("_", " ")}`
                }
              >
                <span className="mono small-text">{seconds(shot.startMs)}</span>
                <span className="shot-desc">{shot.description}</span>
                {shot.render !== "rendered" && (
                  <span className="shot-state">{shot.render.replace("_", " ")}</span>
                )}
                {shot.comments > 0 && <span className="shot-comments">{shot.comments}</span>}
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

export function ProjectView({ projectId }: { projectId: string }) {
  const { data: review, error, reload } = useAsync(() => api.projectReview(projectId), [projectId]);
  const video = useRef<HTMLVideoElement>(null);
  const [takeId, setTakeId] = useState<string>();
  const [tool, setTool] = useState<Tool>("box");
  const [draft, setDraft] = useState<DraftNote>();
  const [notes, setNotes] = useState<DraftNote[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<unknown>();
  const [sent, setSent] = useState<{ notes: DraftNote[]; ids: string[] }>();
  const [warning, setWarning] = useState<string>();
  // Frame capture needs CORS on the video host; without it the take still plays, just without snapshots.
  const [cors, setCors] = useState(true);
  const [playMs, setPlayMs] = useState(0);

  if (!review) return <ErrorBanner error={error} />;

  const takes = review.renders.filter((r) => r.url);
  const take = takes.find((t) => t.id === takeId) ?? takes[0];
  const shots = review.storyboard?.scenes.flatMap((s) => s.shots) ?? [];
  // Notes land on the current version, so only its take can be marked; older takes are for comparing.
  const markable = !!take && (!take.versionId || take.versionId === review.currentVersion?.id);
  const durationMs = review.timeline?.durationMs || shots.at(-1)?.endMs || 1;
  const nowMs = () => Math.round((video.current?.currentTime ?? 0) * 1000);
  const openComments = review.comments.filter(
    (c) => !c.versionId || c.versionId === review.currentVersion?.id,
  );

  function seek(ms: number) {
    if (!video.current) return;
    video.current.currentTime = ms / 1000;
  }

  function startNote() {
    video.current?.pause();
    const ms = nowMs();
    setDraft(blankNote(ms, shotAt(shots, ms)?.id));
    setWarning(undefined);
  }

  async function saveNote() {
    if (!draft) return;
    const v = video.current;
    // The snapshot is of the noted frame, even if the reviewer scrubbed to set an end time.
    if (v && Math.abs(v.currentTime * 1000 - draft.frameMs) > 20) {
      // A video that cannot seek (not loaded, or failing) must not block the note: it goes without a snapshot.
      const ok = await new Promise<boolean>((done) => {
        v.addEventListener("seeked", () => done(true), { once: true });
        v.addEventListener("error", () => done(false), { once: true });
        setTimeout(() => done(false), 1500);
        v.currentTime = draft.frameMs / 1000;
      });
      if (!ok) {
        setNotes([...notes, draft]);
        setDraft(undefined);
        setWarning("The frame could not be loaded, so the note is sent without a snapshot.");
        return;
      }
    }
    const snap = v && take ? snapshot(v, draft) : undefined;
    if (v && take && !snap)
      setWarning("This video host does not allow frame capture, so the note is sent without a snapshot.");
    setNotes([...notes, { ...draft, snapshot: snap }]);
    setDraft(undefined);
  }

  async function sendAll() {
    setSending(true);
    setSendError(undefined);
    const ids: string[] = [];
    const trimmed: string[] = [];
    try {
      for (const n of notes) {
        const req = feedbackRequest(n, review?.currentVersion?.id);
        const lost = droppedImages(n, req);
        if (lost.length) trimmed.push(`${seconds(n.frameMs)}: ${lost.join(", ")}`);
        const res = await api.sendFeedback(projectId, req);
        ids.push(res.feedbackId);
      }
      if (trimmed.length)
        setWarning(
          `Too large to send whole, so these notes went without some images: ${trimmed.join("; ")}.`,
        );
    } catch (e) {
      setSendError(e);
    } finally {
      // Sent notes join the brief, even across retries; the rest stay for the next try (same keys, no duplicates).
      const done = notes.slice(0, ids.length);
      if (done.length) {
        setSent((prev) => ({
          notes: [...(prev?.notes ?? []), ...done],
          ids: [...(prev?.ids ?? []), ...ids],
        }));
        reload();
      }
      setNotes(notes.slice(ids.length));
      setSending(false);
    }
  }

  const brief = sent && agentBrief(projectId, review.project.title, sent.notes, sent.ids);

  return (
    <div className="project-view">
      <header className="page-head">
        <div>
          <p className="muted small-text">
            <Link to="/projects">Projects</Link> /
          </p>
          <h1>{review.project.title}</h1>
        </div>
        <div className="row">
          <StatusBadge status={review.project.status} />
          <Link to={`/projects/${projectId}/review`}>Storyboard review</Link>
          <CopyForAgent small tool="studix_get_project" args={{ projectId, includeFeedback: true }} />
        </div>
      </header>
      <ErrorBanner error={error} />

      <div className="pv-grid">
        <div className="pv-main">
          {takes.length > 1 && (
            <div className="segment takes" role="tablist" aria-label="Takes">
              {takes.map((t, i) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={t.id === take?.id}
                  onClick={() => setTakeId(t.id)}
                >
                  Take {t.version ?? takes.length - i}
                  <span className="muted small-text"> {t.preset}</span>
                </button>
              ))}
            </div>
          )}

          <div
            className="player"
            style={{ aspectRatio: (review.timeline?.aspectRatio ?? "16:9").replace(":", " / ") }}
          >
            {take ? (
              // biome-ignore lint/a11y/useMediaCaption: generated videos have no caption track yet.
              <video
                key={`${take.id}-${cors}`}
                ref={video}
                src={take.url}
                crossOrigin={cors ? "anonymous" : undefined}
                onError={() => cors && setCors(false)}
                onTimeUpdate={(e) => setPlayMs(Math.round(e.currentTarget.currentTime * 1000))}
                controls={!draft}
                preload="metadata"
              />
            ) : (
              <EmptyPlayer jobs={review.cost.jobs} />
            )}
            {draft && (
              <>
                <AnnotateLayer tool={tool} note={draft} onChange={setDraft} />
                <div className="pins-layer">
                  <Pins pins={draft.pins} />
                </div>
              </>
            )}
          </div>

          {shots.length > 0 && (
            <nav className="shot-timeline" aria-label="Shots">
              {shots.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`tl-shot render-${s.render}`}
                  style={{ flexGrow: Math.max(1, s.durationMs) }}
                  title={`${seconds(s.startMs)} ${s.description}`}
                  onClick={() => seek(s.startMs)}
                />
              ))}
              {[...notes, ...(draft ? [draft] : [])].map((n) => (
                <span
                  key={n.id}
                  className={`tl-note prio-${n.priority}`}
                  style={{
                    left: `${(n.frameMs / durationMs) * 100}%`,
                    width: n.endMs ? `${((n.endMs - n.frameMs) / durationMs) * 100}%` : undefined,
                  }}
                />
              ))}
            </nav>
          )}

          <div className="review-bar">
            {draft ? (
              <>
                <fieldset className="segment" aria-label="Drawing tool">
                  {TOOLS.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      aria-pressed={tool === t.id}
                      onClick={() => setTool(t.id)}
                    >
                      {t.label}
                    </button>
                  ))}
                </fieldset>
                <label className="scrub">
                  <span className="mono small-text">{seconds(playMs)}</span>
                  <input
                    type="range"
                    min={0}
                    max={durationMs}
                    step={40}
                    value={playMs}
                    aria-label="Playhead"
                    onChange={(e) => {
                      setPlayMs(Number(e.target.value));
                      seek(Number(e.target.value));
                    }}
                  />
                </label>
                <NoteEditor
                  note={draft}
                  onChange={setDraft}
                  onSave={saveNote}
                  onCancel={() => setDraft(undefined)}
                  currentMs={nowMs}
                />
              </>
            ) : (
              take &&
              (markable ? (
                <button type="button" onClick={startNote}>
                  + Note at playhead
                </button>
              ) : (
                <p className="muted small-text">
                  This is an older take. Switch to the latest take to add notes.
                </p>
              ))
            )}
            {warning && <p className="small-text muted">{warning}</p>}
          </div>

          {notes.length > 0 && (
            <section className="notes">
              <div className="row">
                <h2>Notes to send</h2>
                <button type="button" onClick={() => void sendAll()} disabled={sending || !!draft}>
                  {sending ? "Sending…" : `Send ${notes.length} note${notes.length > 1 ? "s" : ""}`}
                </button>
              </div>
              <ErrorBanner error={sendError} />
              <ul className="note-list">
                {notes.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      className="note-thumb"
                      onClick={() => seek(n.frameMs)}
                      aria-label={`Jump to ${seconds(n.frameMs)}`}
                    >
                      {n.snapshot ? (
                        <img src={n.snapshot} alt="" />
                      ) : (
                        <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                          <Marks note={n} />
                        </svg>
                      )}
                    </button>
                    <div>
                      <div className="row">
                        <span className={`prio prio-${n.priority}`}>{n.priority}</span>
                        <span className="muted small-text">{n.intent}</span>
                        <span className="mono small-text">
                          {seconds(n.frameMs)}
                          {n.endMs !== undefined && ` → ${seconds(n.endMs)}`}
                        </span>
                      </div>
                      <p className="small-text prewrap">{n.text}</p>
                    </div>
                    <div className="row">
                      <button
                        type="button"
                        className="ghost small"
                        onClick={() => {
                          setNotes(notes.filter((x) => x.id !== n.id));
                          setDraft(n);
                          seek(n.frameMs);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="ghost small"
                        onClick={() => setNotes(notes.filter((x) => x.id !== n.id))}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {brief && (
            <section className="brief">
              <div className="row">
                <h2>Sent. Hand it to your agent</h2>
                <CopyForAgent text={brief} />
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    try {
                      sessionStorage.setItem(REVISE_DRAFT_KEY, brief);
                    } catch {
                      // Without storage the Create page simply opens empty.
                    }
                    navigate("/");
                  }}
                >
                  Revise in Studix
                </button>
              </div>
              <pre className="codeblock">{brief}</pre>
            </section>
          )}

          <Storyboard review={review} seek={seek} />
        </div>

        <aside className="pv-side">
          <section>
            <h2>Cost</h2>
            <p className="mono">${(review.cost.spentCents / 100).toFixed(2)}</p>
            <ul className="list">
              {review.cost.jobs.map((j) => (
                <li key={j.id} className="row">
                  <Link to={`/jobs/${j.id}`}>{j.kind}</Link>
                  <StatusBadge status={j.status} />
                  <span className="mono small-text">${(j.spentCents / 100).toFixed(2)}</span>
                  <Link to={`/chat/${j.id}`} className="small-text">
                    chat
                  </Link>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2>Feedback</h2>
            {openComments.length ? (
              <ul className="comments">
                {openComments.map((c) => (
                  <CommentItem key={c.id} c={c} projectId={projectId} />
                ))}
              </ul>
            ) : (
              <p className="muted small-text">No feedback on this version yet.</p>
            )}
          </section>
          <ProgressPanel jobs={review.cost.jobs} />
        </aside>
      </div>
    </div>
  );
}
