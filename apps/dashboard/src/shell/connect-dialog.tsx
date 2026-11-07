import { useEffect, useRef, useState } from "react";
import { CopyForAgent } from "../copy-for-agent.tsx";
import { Link } from "../ui.tsx";

const FIRST_PROMPT = "Make a 30-second product video for my app with Studix, then show me the storyboard.";

function setups(mcpUrl: string): Array<{ id: string; label: string; steps: string; code: string }> {
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      steps: "Run this in your terminal, then sign in when Claude Code asks.",
      code: `claude mcp add --transport http studix ${mcpUrl}`,
    },
    {
      id: "claude-ai",
      label: "Claude.ai",
      steps: "Settings, Connectors, Add custom connector. Paste this URL and sign in.",
      code: mcpUrl,
    },
    {
      id: "chatgpt",
      label: "ChatGPT",
      steps: "Settings, Apps and connectors, Create. Paste this URL and choose OAuth.",
      code: mcpUrl,
    },
    {
      id: "cursor",
      label: "Cursor",
      steps: "Add this to .cursor/mcp.json, then sign in from the MCP panel.",
      code: JSON.stringify({ mcpServers: { studix: { url: mcpUrl } } }, null, 2),
    },
    {
      id: "api",
      label: "API",
      steps: "Create an API key below, then call any tool over JSON-RPC.",
      code: `curl -X POST ${mcpUrl} -H "Authorization: Bearer $STUDIX_API_KEY" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    },
  ];
}

/** Per-client setup for the Studix MCP server, shared by the Connect dialog and Settings, Agents. */
export function ConnectSetup({ mcpUrl }: { mcpUrl: string }) {
  const [tab, setTab] = useState("claude-code");
  const items = setups(mcpUrl);
  const current = items.find((i) => i.id === tab) ?? items[0];
  return (
    <>
      <div className="segment" role="tablist">
        {items.map((i) => (
          <button
            key={i.id}
            type="button"
            role="tab"
            aria-selected={i.id === current?.id}
            onClick={() => setTab(i.id)}
          >
            {i.label}
          </button>
        ))}
      </div>
      {current && (
        <div className="connect-body">
          <p>{current.steps}</p>
          <pre className="codeblock">{current.code}</pre>
          <CopyForAgent text={current.code} label="Copy" />
        </div>
      )}
      <div className="connect-foot">
        <span className="muted">Then ask:</span> <q>{FIRST_PROMPT}</q>{" "}
        <CopyForAgent text={FIRST_PROMPT} label="Copy" small />
      </div>
    </>
  );
}

export function ConnectDialog({
  open,
  onClose,
  mcpUrl,
}: {
  open: boolean;
  onClose: () => void;
  mcpUrl: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  // A link inside the dialog navigates the hash router; close so the page it opens is visible.
  useEffect(() => {
    if (!open) return;
    window.addEventListener("hashchange", onClose);
    return () => window.removeEventListener("hashchange", onClose);
  }, [open, onClose]);
  return (
    <dialog ref={ref} className="modal" onClose={onClose} aria-label="Connect agent">
      <header className="sheet-head">
        <h2>Connect your agent</h2>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>
      <p className="muted">
        Studix is an MCP server. Every action in this app is also a tool your agent can call.
      </p>
      <ConnectSetup mcpUrl={mcpUrl} />
      <p className="muted">
        Keys and connected apps live in <Link to="/settings/agents">Settings, Agents</Link>.
      </p>
    </dialog>
  );
}
