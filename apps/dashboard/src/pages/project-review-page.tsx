import { useState } from "react";
import {
  api,
  type ProjectReview,
  type ReviewApproval,
  type ReviewComment,
  type ReviewShot,
  type StoryboardDecisionRequest,
} from "../api-client.ts";
import { Empty, ErrorBanner, formatDate, Link, Section, StatusBadge, useAsync } from "../ui.tsx";

const RENDER_LABELS: Record<ReviewShot["render"], string> = {
  rendered: "rendered",
  outdated: "render outdated",
  not_rendered: "not rendered",
};

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function ApprovalBadge({ approval }: { approval: ReviewApproval }) {
  return <StatusBadge status={approval.status} label={`approval: ${approval.status.replace(/_/g, " ")}`} />;
}

function RenderBadge({ state }: { state: ReviewShot["render"] }) {
  return <span className={`badge badge-render badge-render-${state}`}>render: {RENDER_LABELS[state]}</span>;
}

function commentsFor(review: ProjectReview, shotId: string): ReviewComment[] {
  return review.comments.filter((c) => c.targetId === `shot:${shotId}`);
}

function ShotRow({
  review,
  shot,
  busy,
  onDecide,
  onComment,
}: {
  review: ProjectReview;
  shot: ReviewShot;
  busy: boolean;
  onDecide: (input: StoryboardDecisionRequest) => Promise<boolean>;
  onComment: (shotId: string, comment: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const comments = commentsFor(review, shot.id);
  const revision = review.storyboard?.revision;
  const decide = async (decision: StoryboardDecisionRequest["decision"]) => {
    const note = draft.trim();
    const ok = await onDecide({
      target: "shot",
      targetId: shot.id,
      decision,
      ...(note ? { note } : {}),
      ...(revision !== undefined ? { expectedRevision: revision } : {}),
    });
    if (ok) setDraft("");
  };

  return (
    <>
      <tr>
        <td className="mono">
          {seconds(shot.startMs)}-{seconds(shot.endMs)}
        </td>
        <td>
          <strong>{shot.id}</strong> <span className="muted">({shot.kind})</span>
          <div>{shot.description}</div>
          {shot.script && <div className="muted prewrap">"{shot.script}"</div>}
        </td>
        <td>
          <ApprovalBadge approval={shot.approval} />
        </td>
        <td>
          <RenderBadge state={shot.render} />
        </td>
        <td>
          {shot.revision !== undefined ? `r${shot.revision}` : "-"}
          {shot.changed && <span className="muted"> changed</span>}
        </td>
        <td>
          <div className="row">
            <button type="button" className="small" disabled={busy} onClick={() => void decide("approved")}>
              Approve
            </button>
            <button
              type="button"
              className="small secondary"
              disabled={busy}
              onClick={() => void decide("changes_requested")}
            >
              Request changes
            </button>
            <button type="button" className="link-button" onClick={() => setOpen((v) => !v)}>
              Comments ({comments.length})
            </button>
          </div>
        </td>
      </tr>
      {open && (
        <tr className="shot-comments">
          <td />
          <td colSpan={5}>
            {comments.length === 0 ? (
              <Empty>No comments on this shot.</Empty>
            ) : (
              <ul className="list">
                {comments.map((c) => (
                  <li key={c.id}>
                    <span className="prewrap">{c.body}</span>{" "}
                    <span className="muted">
                      {c.author.id} - {formatDate(c.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <form
              className="row comment-form"
              onSubmit={(e) => {
                e.preventDefault();
                const comment = draft.trim();
                if (comment) void onComment(shot.id, comment).then((ok) => ok && setDraft(""));
              }}
            >
              <textarea
                aria-label={`Comment on ${shot.id}`}
                value={draft}
                maxLength={1000}
                rows={2}
                placeholder="Comment, or the note sent with Request changes"
                onChange={(e) => setDraft(e.target.value)}
              />
              <button type="submit" className="small secondary" disabled={busy || !draft.trim()}>
                Comment
              </button>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}

function TimelineBar({ review }: { review: ProjectReview }) {
  const total = review.timeline?.durationMs ?? 0;
  const shots = review.storyboard?.scenes.flatMap((s) => s.shots) ?? [];
  if (!total || shots.length === 0) return <Empty>No timeline yet.</Empty>;
  return (
    <ol className="shot-timeline" aria-label="Shot timeline">
      {shots.map((shot) => (
        <li
          key={shot.id}
          className={`shot-segment shot-segment-${shot.approval.status}`}
          style={{
            left: `${(shot.startMs / total) * 100}%`,
            width: `${((shot.endMs - shot.startMs) / total) * 100}%`,
          }}
          title={`${shot.id} ${seconds(shot.startMs)}-${seconds(shot.endMs)} - ${shot.approval.status}, ${RENDER_LABELS[shot.render]}`}
        >
          {shot.id}
        </li>
      ))}
    </ol>
  );
}

/**
 * Review of one project: script, storyboard by scene and shot, timeline, versions, renders and cost.
 * Approval (a person's decision) and render state (what a finished video contains) are shown separately:
 * a rendered shot is not approved until a reviewer approves it. Approving the storyboard is the gate that
 * lets image-to-video stages run.
 */
export function ProjectReviewPage({ projectId }: { projectId: string }) {
  const { data, error, loading, reload } = useAsync(() => api.projectReview(projectId), [projectId]);
  const [actionError, setActionError] = useState<unknown>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  async function act(run: () => Promise<unknown>, success: string): Promise<boolean> {
    setBusy(true);
    setActionError(undefined);
    setNotice(undefined);
    try {
      await run();
      setNotice(success);
      reload();
      return true;
    } catch (e) {
      setActionError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const decide = (input: StoryboardDecisionRequest) =>
    act(
      () => api.decideStoryboard(projectId, input),
      `${input.targetId ?? "Storyboard"}: ${input.decision === "approved" ? "approved" : "changes requested"}.`,
    );
  const comment = (shotId: string, text: string) =>
    act(() => api.sendFeedback(projectId, { shotId, comment: text }), `Comment saved on ${shotId}.`);
  const render = (renderPreset: "preview" | "final") =>
    act(() => api.renderProject(projectId, { renderPreset }), `Render (${renderPreset}) queued.`);

  const storyboard = data?.storyboard;
  const decideStoryboard = async (decision: StoryboardDecisionRequest["decision"]) => {
    const text = note.trim();
    const ok = await decide({
      target: "storyboard",
      decision,
      ...(text ? { note: text } : {}),
      ...(storyboard ? { expectedRevision: storyboard.revision } : {}),
    });
    if (ok) setNote("");
  };
  const playable = data?.renders.filter((r) => r.url) ?? [];

  return (
    <>
      <ErrorBanner error={error} />
      <ErrorBanner error={actionError} />
      {notice && <p className="banner banner-success">{notice}</p>}
      {data && (
        <Section
          title={`Review: ${data.project.title}`}
          actions={
            <div className="row">
              <Link to={`/projects/${data.project.id}`}>Project</Link>
              <button type="button" className="secondary" onClick={reload} disabled={loading}>
                Refresh
              </button>
            </div>
          }
        >
          <dl className="facts">
            <dt>Workflow</dt>
            <dd className="mono">{data.workflowTemplate ?? "-"}</dd>
            <dt>Version</dt>
            <dd>
              {data.currentVersion ? `v${data.currentVersion.version} (${data.currentVersion.source})` : "-"}
              {data.invalidated.length > 0 && (
                <span className="muted"> - changed: {data.invalidated.join(", ")}</span>
              )}
            </dd>
            <dt>Storyboard</dt>
            <dd>
              {storyboard ? (
                <>
                  <ApprovalBadge approval={storyboard.approval} />{" "}
                  <span className="muted">
                    revision {storyboard.revision}, {storyboard.pendingShots} shot(s) not approved
                  </span>
                </>
              ) : (
                "No storyboard until the video is planned."
              )}
            </dd>
            <dt>Cost</dt>
            <dd>{dollars(data.cost.spentCents)}</dd>
          </dl>
          <p className="muted">
            Render state and approval are separate: "rendered" only means a finished video contains the shot.
            Image-to-video stages run after a reviewer approves the storyboard.
          </p>
          {storyboard && (
            <div className="review-actions">
              <textarea
                aria-label="Storyboard note"
                value={note}
                maxLength={1000}
                rows={2}
                placeholder="Optional note for the storyboard decision"
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="row">
                <button type="button" disabled={busy} onClick={() => void decideStoryboard("approved")}>
                  Approve storyboard
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void decideStoryboard("changes_requested")}
                >
                  Request changes
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void render("preview")}
                >
                  Render preview
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void render("final")}
                >
                  Render final
                </button>
              </div>
            </div>
          )}
        </Section>
      )}
      {data && (
        <Section title="Script">
          <p className="prewrap">{data.script.prompt}</p>
          {data.script.lines.length === 0 ? (
            <Empty>No on-screen text yet.</Empty>
          ) : (
            <ol className="list">
              {data.script.lines.map((line) => (
                <li key={line.shotId}>
                  <span className="mono muted">{seconds(line.startMs)}</span> {line.text}
                </li>
              ))}
            </ol>
          )}
        </Section>
      )}
      {storyboard && (
        <Section title="Timeline">
          <TimelineBar review={data} />
          {data.timeline && (
            <p className="muted">
              {seconds(data.timeline.durationMs)} - {data.timeline.aspectRatio} {data.timeline.width}x
              {data.timeline.height} @ {data.timeline.fps} fps
            </p>
          )}
        </Section>
      )}
      {data &&
        storyboard?.scenes.map((scene) => (
          <Section
            key={scene.id}
            title={`${scene.title} (${seconds(scene.startMs)}-${seconds(scene.endMs)})`}
            actions={<ApprovalBadge approval={scene.approval} />}
          >
            {scene.summary && <p className="muted">{scene.summary}</p>}
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Shot</th>
                  <th>Approval</th>
                  <th>Render</th>
                  <th>Revision</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {scene.shots.map((shot) => (
                  <ShotRow
                    key={shot.id}
                    review={data}
                    shot={shot}
                    busy={busy}
                    onDecide={decide}
                    onComment={comment}
                  />
                ))}
              </tbody>
            </table>
          </Section>
        ))}
      {playable.length > 0 && (
        <Section title="Rendered videos">
          {playable.map((r) => (
            <figure key={r.id} className="video">
              {/* biome-ignore lint/a11y/useMediaCaption: generated videos have no caption track yet. */}
              <video src={r.url} controls preload="metadata" />
              <figcaption>
                {r.version !== undefined ? `v${r.version} ` : ""}
                {r.preset} - link expires {formatDate(r.urlExpiresAt)}
              </figcaption>
            </figure>
          ))}
        </Section>
      )}
      {data && (
        <Section title="Versions">
          {data.versions.length === 0 ? (
            <Empty>No versions yet.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Source</th>
                  <th>Change</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {data.versions.map((v) => (
                  <tr key={v.id}>
                    <td>
                      v{v.version}
                      {v.id === data.currentVersion?.id && <span className="muted"> (current)</span>}
                    </td>
                    <td>{v.source}</td>
                    <td>{v.description ?? "-"}</td>
                    <td>{formatDate(v.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}
      {data && (
        <Section title="Cost">
          {data.cost.jobs.length === 0 ? (
            <Empty>No jobs yet.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Status</th>
                  <th>Spent</th>
                  <th>Budget</th>
                </tr>
              </thead>
              <tbody>
                {data.cost.jobs.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <Link to={`/jobs/${j.id}`}>{j.kind}</Link>{" "}
                      <span className="muted">{formatDate(j.createdAt)}</span>
                    </td>
                    <td>
                      <StatusBadge status={j.status} />
                    </td>
                    <td>{dollars(j.spentCents)}</td>
                    <td>{j.budgetCents !== undefined ? dollars(j.budgetCents) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}
    </>
  );
}
