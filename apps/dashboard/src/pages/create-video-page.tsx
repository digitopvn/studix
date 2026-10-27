import { type FormEvent, useState } from "react";
import { api, type CreateVideoRequest } from "../api-client.ts";
import { ErrorBanner, Section } from "../ui.tsx";
import { navigate } from "../use-hash-route.ts";

type AspectRatio = NonNullable<CreateVideoRequest["aspectRatio"]>;

export function CreateVideoPage() {
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("9:16");
  const [seconds, setSeconds] = useState(8);
  const [language, setLanguage] = useState("en");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  // One key per form instance: a double submit or a retry after a network error returns the same job.
  const [idempotencyKey] = useState(() => `dash-${crypto.randomUUID()}`);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.createVideo({
        prompt: prompt.trim(),
        title: title.trim() || undefined,
        aspectRatio,
        durationMs: Math.round(seconds * 1000),
        language,
        idempotencyKey,
      });
      navigate(`/jobs/${result.job.id}`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <Section title="Create video">
      <form className="form" onSubmit={submit}>
        <label>
          What should the video show?
          <textarea
            required
            rows={5}
            maxLength={4000}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Brand intro for Acme Coffee: logo reveal, slogan 'Wake up bold', warm palette."
          />
        </label>
        <label>
          Title (optional)
          <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="row">
          <label>
            Format
            <select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}>
              <option value="9:16">9:16 vertical</option>
              <option value="16:9">16:9 landscape</option>
              <option value="1:1">1:1 square</option>
            </select>
          </label>
          <label>
            Duration (s)
            <input
              type="number"
              min={1}
              max={600}
              step={1}
              value={seconds}
              onChange={(e) => setSeconds(Number(e.target.value))}
            />
          </label>
          <label>
            Language
            <select value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="en">English</option>
              <option value="vi">Tiếng Việt</option>
            </select>
          </label>
        </div>
        <ErrorBanner error={error} />
        <button type="submit" disabled={busy || prompt.trim() === ""}>
          {busy ? "Starting..." : "Create video"}
        </button>
      </form>
    </Section>
  );
}
