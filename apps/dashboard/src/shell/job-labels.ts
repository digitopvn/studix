import type { Job } from "../api-client.ts";

/** Plain names for job kinds, steps and errors, shared by the Activity panel and page. */
const KIND_TITLES: Record<string, string> = {
  "video.create": "New video",
  video_create: "New video",
  "video.feedback": "Revision",
  "video.render": "Render",
  "composition.run": "Composition",
};

const STEP_LABELS: Record<string, string> = {
  brief: "Brief",
  "skill-agent.director": "Directing",
  "skill-agent.run": "Building",
  "skill-agent.compose": "Composing",
  "skill-agent.qa": "Checking",
  render: "Rendering",
};

export function jobTitle(job: Job): string {
  return KIND_TITLES[job.kind] ?? job.kind.replace(/[._]/g, " ");
}

export function stepLabel(job: Job): string {
  if (!job.stage) return "Starting";
  return STEP_LABELS[job.stage] ?? job.stage.replace(/^skill-agent\./, "").replace(/[._-]/g, " ");
}

/** A missing or rejected provider key: adding one is the fix, so it leads; otherwise Retry does. */
export function needsKey(job: Job): boolean {
  const e = job.error;
  if (!e) return false;
  return (
    /UNAUTH|CREDENTIAL|PROVIDER_KEY|NO_RUNTIME/.test(e.code) ||
    /\b(api key|no key|credential)/i.test(e.message)
  );
}

/** Provider errors append a raw JSON body; the sentence before it is what a person needs. */
export function shortError(message: string): string {
  return message.replace(/\s*[{[].*$/s, "").replace(/[:\s]+$/, "") || message;
}
