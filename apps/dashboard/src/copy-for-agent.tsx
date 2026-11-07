import { useState } from "react";

/** The exact MCP call for an object, so the user's own agent picks up where the app is. */
export function mcpCall(tool: string, args: Record<string, unknown>): string {
  return `Call the Studix MCP tool ${tool} with ${JSON.stringify(args)}`;
}

export function CopyForAgent({
  tool,
  args,
  text,
  small,
  label = "Copy for agent",
}: {
  tool?: string;
  args?: Record<string, unknown>;
  text?: string;
  small?: boolean;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    const value = text ?? mcpCall(tool ?? "", args ?? {});
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Copy this for your agent", value);
    }
  }
  return (
    <button type="button" className={`secondary${small ? " small" : ""}`} onClick={() => void copy()}>
      {copied ? "Copied" : label}
    </button>
  );
}
