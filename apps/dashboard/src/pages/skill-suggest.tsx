import { type KeyboardEvent, useMemo, useState } from "react";
import { api, type SkillListItem } from "../api-client.ts";
import { useAsync } from "../ui.tsx";

const MAX = 6;

/**
 * Typing "/" at the start of a word suggests the workspace's enabled skills. A picked skill becomes a tag beside the
 * message; Backspace at the start of the message removes the last tag whole. On send, the tags lead the prompt as
 * "/name", which tells the agent to use those skills.
 */
export function useSkillSuggest(message: string, setMessage: (text: string) => void) {
  const skills = useAsync(() => api.skills());
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const query = /(?:^|\s)\/([\w-]*)$/.exec(message)?.[1];
  const matches = useMemo(() => {
    if (query === undefined || message === dismissed) return [];
    const q = query.toLowerCase();
    return (skills.data?.items ?? [])
      .filter((s) => s.status === "enabled" && !picked.includes(s.name) && s.name.toLowerCase().includes(q))
      .sort(
        (a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)),
      )
      .slice(0, MAX);
  }, [query, message, dismissed, picked, skills.data]);
  const current = Math.min(active, Math.max(0, matches.length - 1));

  function pick(skill: SkillListItem) {
    setPicked((p) => [...p, skill.name]);
    setMessage(message.replace(/\s*\/[\w-]*$/, ""));
    setActive(0);
  }

  const remove = (name: string) => setPicked((p) => p.filter((n) => n !== name));

  /** Handles the menu's and tags' keys; returns true when it used the key. */
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
    const t = e.currentTarget;
    if (e.key === "Backspace" && picked.length && t.selectionStart === 0 && t.selectionEnd === 0) {
      e.preventDefault();
      setPicked((p) => p.slice(0, -1));
      return true;
    }
    if (!matches.length) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + matches.length) % matches.length);
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      const skill = matches[current];
      if (skill) pick(skill);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setDismissed(message);
      return true;
    }
    return false;
  }

  const menu = matches.length ? (
    <div className="skill-suggest" role="listbox" aria-label="Skills">
      {matches.map((s, i) => (
        <button
          key={s.id}
          type="button"
          role="option"
          aria-selected={i === current}
          onMouseEnter={() => setActive(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            pick(s);
          }}
        >
          <strong>/{s.name}</strong>
          {s.description && <span className="muted">{s.description}</span>}
        </button>
      ))}
    </div>
  ) : null;

  const tags = picked.length ? (
    <>
      {picked.map((name) => (
        <span key={name} className="skill-tag">
          /{name}
          <button type="button" aria-label={`Remove ${name}`} onClick={() => remove(name)}>
            ×
          </button>
        </span>
      ))}
    </>
  ) : null;

  /** The prompt the agent gets: picked skills first, then the message. */
  const withSkills = (text: string) => [...picked.map((n) => `/${n}`), text].join(" ");
  const clear = () => setPicked([]);

  return { menu, tags, onKeyDown, withSkills, clear };
}
