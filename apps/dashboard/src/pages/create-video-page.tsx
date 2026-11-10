import { type FormEvent, useState } from "react";
import { type AgentRuntimeName, api, type CreateVideoRequest, type ReasoningEffort } from "../api-client.ts";
import { ErrorBanner, Section, useAsync } from "../ui.tsx";
import { navigate } from "../use-hash-route.ts";

type AspectRatio = NonNullable<CreateVideoRequest["aspectRatio"]>;

const RUNTIME_LABELS: Record<AgentRuntimeName, string> = { claude: "Claude", codex: "Codex", pi: "Pi" };
const EFFORTS: ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function CreateVideoPage() {
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [messages, setMessages] = useState("");
  const [callToAction, setCallToAction] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("9:16");
  const [seconds, setSeconds] = useState(8);
  // "" = detected from the copy, so Vietnamese key messages are not read as English.
  const [language, setLanguage] = useState("");
  const [pack, setPack] = useState("");
  const [renderPreset, setRenderPreset] = useState<"preview" | "final">("final");
  // "" = the workspace's default agent; otherwise "runtime:connectionId".
  const [agentKey, setAgentKey] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<ReasoningEffort | "">("");
  const [error, setError] = useState<unknown>();
  const packs = useAsync(() => api.workflowPacks());
  const connections = useAsync(() => api.providerConnections());
  const catalog = useAsync(() => api.providerCatalog());
  // Only keys this user may run jobs with: workspace keys and their own personal keys, once per runtime.
  const agents = (connections.data?.connections ?? [])
    .filter((c) => c.status !== "invalid" && (c.owner === "workspace" || c.ownedByMe))
    .flatMap((c) => c.runtimes.map((runtime) => ({ key: `${runtime}:${c.id}`, runtime, connection: c })));
  const chosen = agents.find((a) => a.key === agentKey);
  const models = chosen
    ? (catalog.data?.providers.find((p) => p.id === chosen.connection.provider)?.models ?? [])
    : [];
  const reasoning = models.find((m) => m.id === model)?.reasoning ?? false;
  const [busy, setBusy] = useState(false);
  // One key per form instance: a double submit or a retry after a network error returns the same job.
  const [idempotencyKey] = useState(() => `dash-${crypto.randomUUID()}`);

  const keyMessages = messages
    .split("\n")
    .map((m) => m.trim())
    .filter(Boolean);
  // Only marketing-video takes its spoken copy from the form; other packs draft theirs from the prompt,
  // and a key message would stop the brand-intro pack from drafting its brief.
  const marketing = pack === "marketing-video";
  // A marketing ad speaks its copy: without a key message there is nothing to open it with.
  const needsMessages = marketing && keyMessages.length === 0;

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
        ...(language ? { language } : {}),
        ...(marketing && keyMessages.length ? { keyMessages } : {}),
        ...(marketing && callToAction.trim() ? { callToAction: callToAction.trim() } : {}),
        idempotencyKey,
        renderPreset,
        ...(pack ? { workflowTemplate: pack } : {}),
        ...(chosen
          ? {
              agent: {
                runtime: chosen.runtime,
                providerConnectionId: chosen.connection.id,
                ...(model ? { model } : {}),
                ...(effort && reasoning ? { reasoningEffort: effort } : {}),
              },
            }
          : {}),
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
        {marketing && (
          <>
            <label>
              Key messages (one per line, in the order spoken; the first opens the ad)
              <textarea
                required
                rows={3}
                value={messages}
                onChange={(e) => setMessages(e.target.value)}
                placeholder="Roasted in house every morning"
              />
            </label>
            <label>
              Call to action (optional)
              <input value={callToAction} maxLength={200} onChange={(e) => setCallToAction(e.target.value)} />
            </label>
          </>
        )}
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
              <option value="">Detect from text</option>
              <option value="en">English</option>
              <option value="vi">Tiếng Việt</option>
            </select>
          </label>
        </div>
        <div className="row">
          <label>
            Pack
            <select value={pack} onChange={(e) => setPack(e.target.value)}>
              <option value="">Default (brand intro)</option>
              {(packs.data?.packs ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Render
            <select
              value={renderPreset}
              onChange={(e) => setRenderPreset(e.target.value as "preview" | "final")}
            >
              <option value="final">Final (1080p)</option>
              <option value="preview">Preview (fast, low-res)</option>
            </select>
          </label>
        </div>
        <div className="row">
          <label>
            Agent
            <select
              value={agentKey}
              onChange={(e) => {
                setAgentKey(e.target.value);
                setModel("");
                setEffort("");
              }}
            >
              <option value="">Workspace default</option>
              {agents.map((a) => (
                <option key={a.key} value={a.key}>
                  {RUNTIME_LABELS[a.runtime]}, billed to {a.connection.label}
                </option>
              ))}
            </select>
          </label>
          {chosen && (
            <label>
              Model
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">Runtime default</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {chosen && reasoning && (
            <label>
              Reasoning effort
              <select value={effort} onChange={(e) => setEffort(e.target.value as ReasoningEffort | "")}>
                <option value="">Model default</option>
                {EFFORTS.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <ErrorBanner error={error} />
        <button type="submit" disabled={busy || prompt.trim() === "" || needsMessages}>
          {busy ? "Starting..." : "Create video"}
        </button>
      </form>
    </Section>
  );
}
