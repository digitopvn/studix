import { useEffect, useRef, useState } from "react";
import { api } from "../api-client.ts";

/**
 * The project's latest playable render as its card picture: fetched only once the card scrolls into view, shown
 * as an early frame, and played muted while hovered. Projects without a render keep the coloured frame.
 */
export function ProjectThumbnail({ projectId }: { projectId: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    if (!anchor) return;
    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        void api
          .projectReview(projectId)
          .then((review) => {
            const latest = [...review.renders]
              .filter((r) => r.url)
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
            if (!cancelled && latest?.url) setUrl(latest.url);
          })
          .catch(() => undefined);
      },
      { rootMargin: "200px" },
    );
    observer.observe(anchor);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [anchor, projectId]);

  return (
    <span ref={setAnchor} className="poster-media" aria-hidden="true">
      {url && (
        // biome-ignore lint/a11y/useMediaCaption: a muted card preview; the project page plays it with captions.
        <video
          ref={ref}
          src={`${url}#t=0.5`}
          muted
          loop
          playsInline
          preload="metadata"
          onMouseEnter={() => void ref.current?.play().catch(() => undefined)}
          onMouseLeave={() => ref.current?.pause()}
        />
      )}
    </span>
  );
}
