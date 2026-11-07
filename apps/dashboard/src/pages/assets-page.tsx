import { useState } from "react";
import { ASSET_ROLES, type AssetItem, type AssetRole, api } from "../api-client.ts";
import { Empty, ErrorBanner, formatDate, Section, useAsync } from "../ui.tsx";

function size(bytes?: number): string {
  if (bytes === undefined) return "";
  return bytes < 1_048_576
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function AssetRow({ asset, onSaved }: { asset: AssetItem; onSaved: () => void }) {
  const [error, setError] = useState<unknown>();
  async function save(patch: Parameters<typeof api.updateAsset>[1]) {
    setError(undefined);
    try {
      await api.updateAsset(asset.id, patch);
      onSaved();
    } catch (e) {
      setError(e);
    }
  }
  return (
    <li className="key-row">
      <div className="key-main">
        <div className="key-title">
          <strong>{asset.name}</strong>
        </div>
        <div className="key-meta">
          <span>{asset.kind}</span>
          {asset.mime && <span className="mono">{asset.mime}</span>}
          <span>{size(asset.bytes)}</span>
          <span>{formatDate(asset.updatedAt)}</span>
        </div>
        <ErrorBanner error={error} />
      </div>
      <div className="row">
        <select
          aria-label={`Role of ${asset.name}`}
          value={asset.role}
          onChange={(e) => save({ role: e.target.value as AssetRole })}
        >
          {ASSET_ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
        <input
          aria-label={`Folder of ${asset.name}`}
          className="mono"
          placeholder="folder, e.g. ep03/sc01"
          defaultValue={asset.path}
          onBlur={(e) => e.target.value.trim() !== asset.path && save({ path: e.target.value })}
        />
        <input
          aria-label={`Tags of ${asset.name}`}
          placeholder="tags, comma separated"
          defaultValue={asset.tags.join(", ")}
          onBlur={(e) => {
            const tags = e.target.value
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean);
            if (tags.join(",") !== asset.tags.join(",")) save({ tags });
          }}
        />
      </div>
    </li>
  );
}

/** The workspace asset library: filter by role and folder, and organize what agents saved. */
export function AssetsPage() {
  const [role, setRole] = useState<AssetRole | "">("");
  const [folder, setFolder] = useState("");
  const { data, error, reload } = useAsync(
    () => api.assets({ ...(role ? { role } : {}), ...(folder.trim() ? { path: folder.trim() } : {}) }),
    [role, folder],
  );
  return (
    <Section title="Assets">
      <p className="muted">
        Every file your agents save has a role and a folder such as ep03/sc01/s05. Change them here, or ask
        your agent.
      </p>
      <div className="row">
        <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as AssetRole | "")}>
          <option value="">All roles</option>
          {ASSET_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <input
          aria-label="Folder"
          className="mono"
          placeholder="Folder, e.g. ep03"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
        />
      </div>
      <ErrorBanner error={error} />
      {data && data.assets.length === 0 && <Empty>No assets match.</Empty>}
      {data && data.assets.length > 0 && (
        <ul className="key-list">
          {data.assets.map((a) => (
            <AssetRow key={`${a.id}-${a.updatedAt}`} asset={a} onSaved={reload} />
          ))}
        </ul>
      )}
      {data?.nextCursor && <p className="muted">Showing the newest 50. Narrow the filters to see more.</p>}
    </Section>
  );
}
