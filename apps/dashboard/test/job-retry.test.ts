import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, type Job } from "../src/api-client.ts";
import { canRetry, JobActions, runJobAction } from "../src/pages/job-detail-page.tsx";
import { ErrorBanner } from "../src/ui.tsx";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    kind: "video.create",
    status: "failed",
    progress: 0.4,
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
    ...overrides,
  };
}

function actions(target: Job, busy = false) {
  const onCancel = vi.fn();
  const onRetry = vi.fn();
  const props = { job: target, busy, onCancel, onRetry };
  return { onCancel, onRetry, props, html: renderToStaticMarkup(createElement(JobActions, props)) };
}

function buttons(node: unknown): ReactElement<{ onClick: () => void; children: unknown }>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<{ onClick: () => void; children: unknown }>;
  return element.type === "button" ? [element] : buttons(element.props.children);
}

describe("job detail retry action", () => {
  it("offers Retry only for a failed job that is not a publish", () => {
    expect(actions(job()).html).toContain("Retry job");
    expect(canRetry(job())).toBe(true);
    for (const status of ["queued", "running", "waiting_approval", "succeeded", "cancelled"]) {
      expect(actions(job({ status })).html).not.toContain("Retry");
    }
    expect(actions(job({ kind: "video.publish" })).html).not.toContain("Retry");
  });

  it("keeps Cancel for active jobs and disables Retry while an action runs", () => {
    const running = actions(job({ status: "running" })).html;
    expect(running).toContain("Cancel job");
    const busy = actions(job(), true).html;
    expect(busy).toContain("Retrying...");
    expect(busy).toMatch(/<button[^>]*disabled/);
  });

  it("calls onRetry when the Retry button is clicked", () => {
    const { props, onRetry, onCancel } = actions(job());
    const [retry] = buttons(JobActions(props));
    expect(retry?.props.children).toBe("Retry job");
    retry?.props.onClick();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("api.retryJob", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", { getItem: () => "ws_1", setItem: vi.fn(), removeItem: vi.fn() });
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("POSTs to the retry endpoint and refreshes the job on success", async () => {
    const requeued = job({ id: "job/1", status: "queued" });
    fetchMock.mockResolvedValue(new Response(JSON.stringify(requeued), { status: 200 }));
    const refresh = vi.fn();

    const error = await runJobAction(() => api.retryJob("job/1"), refresh);

    expect(error).toBeUndefined();
    expect(refresh).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/jobs/job%2F1/retry");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("{}");
    expect(init?.headers).toMatchObject({ "x-studix-workspace": "ws_1" });
  });

  it("surfaces a refused retry as the server's message without refreshing", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "APPROVAL_REQUIRED",
            message: "job job_1 was never approved to start",
            suggestedAction: "Create the job again and have a workspace member approve it in the dashboard.",
          },
        }),
        { status: 403 },
      ),
    );
    const refresh = vi.fn();

    const error = await runJobAction(() => api.retryJob("job_1"), refresh);

    expect(refresh).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("APPROVAL_REQUIRED");
    const banner = renderToStaticMarkup(createElement(ErrorBanner, { error }));
    expect(banner).toContain('role="alert"');
    expect(banner).toContain("job job_1 was never approved to start");
    expect(banner).toContain("have a workspace member approve it");
  });
});
