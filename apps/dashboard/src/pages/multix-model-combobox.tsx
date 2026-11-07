import { type KeyboardEvent, useId, useState } from "react";
import type { MultixCatalogEntry } from "../api-client.ts";
import { modelOptions, modelWarning } from "./multix-model-options.ts";

interface Props {
  label: string;
  value: string;
  /** Model the server uses when the value is blank. */
  serverValue: string;
  entries: readonly MultixCatalogEntry[];
  openVendors: readonly string[];
  disabled?: boolean;
  onChange: (value: string) => void;
}

/**
 * A searchable model picker (ARIA combobox). Typing filters the role's catalogue models; Arrow keys move,
 * Enter picks, Escape closes. Any typed value is kept, so a model the catalogue does not list still saves.
 */
export function MultixModelCombobox({
  label,
  value,
  serverValue,
  entries,
  openVendors,
  disabled,
  onChange,
}: Props) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const options = open ? modelOptions(entries, query, value) : [];
  const warning = modelWarning(value, entries, openVendors);

  function pick(next: string) {
    onChange(next);
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (options.length === 0 ? 0 : (i + step + options.length) % options.length));
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      const option = options[active];
      if (option) pick(option.value);
      else setOpen(false);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      setQuery("");
    }
  }

  return (
    <div className="combobox">
      <input
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        className="mono"
        placeholder={serverValue}
        value={value}
        disabled={disabled}
        onFocus={() => {
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => {
          setOpen(false);
          setQuery("");
        }}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          onChange(e.target.value);
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
      />
      {open && (
        <div id={listId} role="listbox" className="combobox-list">
          {options.length === 0 && (
            <div className="muted">No catalogue model matches; the typed value is kept.</div>
          )}
          {options.map((option, i) => (
            <div
              key={option.value || "(server)"}
              id={`${listId}-${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              className={i === active ? "active" : undefined}
              // mousedown, not click: it runs before the input's blur closes the list.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(option.value);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {option.value === "" ? (
                <span className="muted">Use server value ({serverValue})</span>
              ) : (
                <>
                  <span className="mono">{option.value}</span>
                  {option.label && <span className="muted"> {option.label}</span>}
                  {option.needsKey && (
                    <>
                      {" "}
                      <span className="badge">needs key</span>
                    </>
                  )}
                  {option.price && <span className="muted"> {option.price}</span>}
                  {option.unpriced && (
                    <>
                      {" "}
                      <span className="badge">no trusted price</span>
                    </>
                  )}
                  {option.capabilities && (
                    <span className="muted combobox-caps"> {option.capabilities.join(", ")}</span>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {warning && <div className="combobox-warning">{warning}</div>}
    </div>
  );
}
