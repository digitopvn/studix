import { type FormEvent, useState } from "react";
import {
  api,
  type DiagnosticClass,
  type MultixCheckResult,
  type PlatformMedia,
  type PlatformVendor,
  type StorageTestResult,
} from "../api-client.ts";
import { Empty, ErrorBanner, formatDate, Section, StatusBadge, useAsync } from "../ui.tsx";

const DIAGNOSTIC_LABELS: Record<DiagnosticClass, string> = {
  ok: "Working",
  missing_credential: "Missing credential",
  bad_credential: "Bad credential",
  missing_executable: "Missing executable",
  missing_permission: "Missing permission",
  remote_unavailable: "Remote unavailable",
};

const VENDOR_STATUS_LABELS: Record<PlatformVendor["status"], string> = {
  configured: "Configured",
  missing: "Missing",
  revoked: "Revoked",
  invalid: "Invalid",
};

const VENDOR_NAMES: Record<string, string> = {
  sume: "Sume",
  atlas: "Atlas Cloud",
  elevenlabs: "ElevenLabs",
  fish: "Fish Audio",
  minimax: "MiniMax",
  openrouter: "OpenRouter",
};

const KIND_LABELS: Record<string, string> = {
  image: "image",
  video: "video",
  lipsync: "lip-sync",
  videoUpscale: "video upscale",
  imageUpscale: "image upscale",
  voice: "voice",
  music: "music",
  sfx: "SFX",
};

function DiagnosticBadge({ ok, diagnostic }: { ok: boolean; diagnostic: DiagnosticClass }) {
  return <StatusBadge status={ok ? "available" : "invalid"} label={DIAGNOSTIC_LABELS[diagnostic]} />;
}

/**
 * Platform operators only: R2 object storage and the media vendor keys Studix gives the Multix CLI.
 * Secrets are typed into a password field, sent once and cleared; nothing here can show a stored value.
 */
export function StorageMediaPage() {
  const { data, error, reload } = useAsync(() => api.platformMedia());
  return (
    <>
      <ErrorBanner error={error} />
      {data && (
        <>
          <StorageCard storage={data.storage} note={data.apply.storage} reload={reload} />
          <MultixCard media={data} reload={reload} />
          <VendorsCard media={data} reload={reload} />
        </>
      )}
    </>
  );
}

function StorageCard({
  storage,
  note,
  reload,
}: {
  storage: PlatformMedia["storage"];
  note: string;
  reload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const [result, setResult] = useState<StorageTestResult | undefined>(storage.lastTest);
  const last = result ?? storage.lastTest;

  async function test() {
    setBusy(true);
    setActionError(undefined);
    try {
      setResult(await api.testPlatformStorage());
      reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Object storage (Cloudflare R2)"
      actions={
        <button type="button" disabled={busy || !storage.configured} onClick={test}>
          Test connection
        </button>
      }
    >
      <p className="muted">{note}</p>
      <ErrorBanner error={actionError} />
      <table>
        <tbody>
          <tr>
            <th>Endpoint</th>
            <td className="mono">{storage.endpointHost ?? "AWS S3 default"}</td>
          </tr>
          <tr>
            <th>Bucket</th>
            <td className="mono">{storage.bucket ?? "-"}</td>
          </tr>
          <tr>
            <th>Region</th>
            <td className="mono">{storage.region}</td>
          </tr>
          <tr>
            <th>Access key ID</th>
            <td className="mono">{storage.accessKeyId ?? "-"}</td>
          </tr>
          <tr>
            <th>Secret access key</th>
            <td>
              <StatusBadge
                status={storage.secretAccessKey === "configured" ? "available" : "invalid"}
                label={storage.secretAccessKey === "configured" ? "Configured" : "Missing"}
              />
            </td>
          </tr>
          <tr>
            <th>Last test</th>
            <td>
              {last ? (
                <>
                  <DiagnosticBadge ok={last.ok} diagnostic={last.diagnostic} /> {formatDate(last.at)}
                  <div className="muted">
                    {last.message}
                    {!last.ok && last.step ? ` Failed at: ${last.step}.` : ""}
                    {last.status ? ` HTTP ${last.status}.` : ""}
                    {last.s3Code ? ` S3 code: ${last.s3Code}.` : ""}
                  </div>
                </>
              ) : (
                "Not tested yet"
              )}
            </td>
          </tr>
        </tbody>
      </table>
      {!storage.configured && <Empty>S3_BUCKET is not set, so object storage is not configured.</Empty>}
    </Section>
  );
}

function MultixCard({ media, reload }: { media: PlatformMedia; reload: () => void }) {
  const { multix } = media;
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const [result, setResult] = useState<MultixCheckResult | undefined>(multix.lastCheck);
  const last = result ?? multix.lastCheck;

  async function check() {
    setBusy(true);
    setActionError(undefined);
    try {
      setResult(await api.checkMultix());
      reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Multix CLI"
      actions={
        <button type="button" disabled={busy || !multix.enabled} onClick={check}>
          Run multix check
        </button>
      }
    >
      <p className="muted">
        The check is free: it reports whether each vendor key is present for the CLI. It does not spend money
        to prove a vendor accepts a key; the first paid job does.
      </p>
      <ErrorBanner error={actionError} />
      <table>
        <tbody>
          <tr>
            <th>Executable</th>
            <td>
              {multix.enabled ? (
                <>
                  <StatusBadge status="available" label="Available" />{" "}
                  <span className="mono">{multix.bin}</span>
                </>
              ) : (
                <>
                  <StatusBadge status="invalid" label="Missing executable" />{" "}
                  <span className="muted">{multix.reason ?? "MULTIX_BIN is not set"}</span>
                </>
              )}
            </td>
          </tr>
          <tr>
            <th>Last check</th>
            <td>
              {last ? (
                <>
                  <DiagnosticBadge ok={last.ok} diagnostic={last.diagnostic} /> {formatDate(last.at)}
                  <div className="muted">{last.message}</div>
                </>
              ) : (
                "Not checked yet"
              )}
            </td>
          </tr>
        </tbody>
      </table>
    </Section>
  );
}

function VendorsCard({ media, reload }: { media: PlatformMedia; reload: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState<unknown>();
  const [notice, setNotice] = useState<string>();

  async function act(vendor: string, action: () => Promise<unknown>, done?: string) {
    setBusy(vendor);
    setActionError(undefined);
    setNotice(undefined);
    try {
      await action();
      if (done) setNotice(done);
      reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(undefined);
    }
  }

  async function save(event: FormEvent, vendor: string) {
    event.preventDefault();
    const key = (drafts[vendor] ?? "").trim();
    // The secret leaves component state as soon as it is sent, whether or not the server accepts it.
    setDrafts((d) => ({ ...d, [vendor]: "" }));
    if (!key) return;
    await act(vendor, () => api.saveMediaVendorKey(vendor, key), media.apply.mediaKeys);
  }

  async function revoke(vendor: string) {
    if (
      !window.confirm(
        `Revoke the ${VENDOR_NAMES[vendor] ?? vendor} key in Studix? It stays valid at the vendor until you revoke it there.`,
      )
    ) {
      return;
    }
    await act(vendor, () => api.revokeMediaVendorKey(vendor), media.apply.mediaKeys);
  }

  return (
    <Section title="Media provider keys">
      <p className="muted">
        Keys are encrypted before they are stored and can never be shown again; paste a new one to rotate it.
        A revoked key stays off even if the deployment environment still has a value for it.
      </p>
      <ErrorBanner error={actionError} />
      {notice && <p className="banner">{notice}</p>}
      <table>
        <thead>
          <tr>
            <th>Vendor</th>
            <th>Used for</th>
            <th>Status</th>
            <th>Key</th>
            <th>Updated</th>
            <th>Add or rotate</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {media.vendors.map((v) => (
            <tr key={v.id}>
              <td>
                {VENDOR_NAMES[v.vendor] ?? v.vendor}
                <div className="muted mono">{v.envName}</div>
              </td>
              <td>{v.kinds.map((k) => KIND_LABELS[k] ?? k).join(", ")}</td>
              <td>
                <StatusBadge status={statusClass(v)} label={VENDOR_STATUS_LABELS[v.status]} />
                <div className="muted">
                  {v.source === "env"
                    ? "From the deployment environment"
                    : v.source === "platform"
                      ? "Stored in Studix"
                      : ""}
                </div>
                {v.lastTest && (
                  <div className="muted">
                    Last check: {v.lastTest.ok ? "key found" : "key not found"} · {formatDate(v.lastTest.at)}
                  </div>
                )}
              </td>
              <td className="mono">{v.keyHint ?? "-"}</td>
              <td>{v.updatedAt ? formatDate(v.updatedAt) : "-"}</td>
              <td>
                <form className="row" onSubmit={(e) => save(e, v.id)}>
                  <input
                    type="password"
                    autoComplete="new-password"
                    aria-label={`${VENDOR_NAMES[v.vendor] ?? v.vendor} API key`}
                    placeholder="Paste key"
                    value={drafts[v.id] ?? ""}
                    disabled={busy === v.id}
                    onChange={(e) => setDrafts((d) => ({ ...d, [v.id]: e.target.value }))}
                  />
                  <button type="submit" disabled={busy === v.id || !(drafts[v.id] ?? "").trim()}>
                    Save
                  </button>
                </form>
              </td>
              <td>
                {v.status !== "revoked" && v.status !== "missing" && (
                  <button
                    type="button"
                    className="danger"
                    disabled={busy === v.id}
                    onClick={() => revoke(v.id)}
                  >
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function statusClass(v: PlatformVendor): string {
  if (v.status === "configured") return "available";
  if (v.status === "missing") return "pending";
  return "invalid";
}
