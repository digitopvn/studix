import { type FormEvent, useState } from "react";
import {
  api,
  type PlatformCredential,
  type PlatformCredentialStatus,
  type PlatformCredentials,
  type PlatformTestResult,
} from "../api-client.ts";
import { Empty, ErrorBanner, errorText, formatDate, Section, StatusBadge, useAsync } from "../ui.tsx";

const STATUS: Record<PlatformCredentialStatus, { badge: string; label: string }> = {
  configured: { badge: "available", label: "Configured" },
  missing: { badge: "invalid", label: "Missing" },
  invalid: { badge: "invalid", label: "Invalid" },
  unverified: { badge: "unverified", label: "Unverified" },
};

const SOURCE_LABEL = { dashboard: "Dashboard", environment: "Environment", none: "Not set" } as const;

function TestOutcome({ test }: { test?: PlatformTestResult }) {
  if (!test) return <span className="muted">Not tested</span>;
  return (
    <span className={test.ok ? undefined : "muted"}>
      {test.ok ? "Passed" : `Failed${test.step ? ` at ${test.step}` : ""}`}
      {test.httpStatus ? ` (HTTP ${test.httpStatus})` : ""} · {formatDate(test.at)}
      {test.error && (
        <>
          <br />
          {errorText(test.error)}
        </>
      )}
    </span>
  );
}

/**
 * Platform infrastructure for the operator: the object-storage access key and the media vendor keys.
 * Secrets are typed into a form once and are never shown again; the server returns status and a four
 * character hint only.
 */
export function StorageMediaPage() {
  const { data, error, reload } = useAsync(() => api.platformCredentials());
  const [overview, setOverview] = useState<PlatformCredentials>();
  const [actionError, setActionError] = useState<unknown>();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const current = overview ?? data;

  async function run(
    label: string,
    action: () => Promise<PlatformCredentials | PlatformTestResult | undefined>,
  ) {
    setBusy(label);
    setActionError(undefined);
    setNotice(undefined);
    try {
      const result = await action();
      if (result && "storage" in result) setOverview(result);
      else reload();
      return result;
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <>
      <ErrorBanner error={error} />
      <ErrorBanner error={actionError} />
      {notice && <p className="banner banner-success">{notice}</p>}
      {current && (
        <>
          {current.secretStorage === "unavailable" && (
            <p className="banner banner-error" role="alert">
              Encrypted credential storage is off. Set <code>STUDIX_SECRETS_KEY</code> on the app and the
              worker to store keys here. Until then the deployment environment is used.
            </p>
          )}
          <StorageCard data={current} busy={busy} run={run} setNotice={setNotice} />
          <MediaCard data={current} busy={busy} run={run} setNotice={setNotice} />
          <Section title="When changes apply">
            <p className="muted">
              No restart needed: a change reaches the app and the worker within {current.apply.withinSeconds}{" "}
              seconds.
            </p>
            <p className="muted">{current.apply.runningJobs}</p>
            <p className="muted">{current.apply.scope}</p>
          </Section>
        </>
      )}
    </>
  );
}

type Run = (
  label: string,
  action: () => Promise<PlatformCredentials | PlatformTestResult | undefined>,
) => Promise<PlatformCredentials | PlatformTestResult | undefined>;

interface CardProps {
  data: PlatformCredentials;
  busy?: string;
  run: Run;
  setNotice: (message: string) => void;
}

function StorageCard({ data, busy, run, setNotice }: CardProps) {
  const { storage } = data;
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const credential = storage.credentials;
  const canStore = data.secretStorage === "available" && storage.configured;

  async function save(event: FormEvent) {
    event.preventDefault();
    const saved = await run("storage-save", () =>
      api.savePlatformStorage({ accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim() }),
    );
    if (saved) {
      setAccessKeyId("");
      setSecretAccessKey("");
      setNotice("Storage key verified with a write, read and delete, then saved.");
    }
  }

  return (
    <Section
      title="Object storage (Cloudflare R2)"
      actions={
        <button
          type="button"
          className="secondary"
          disabled={!storage.configured || busy !== undefined}
          onClick={() => void run("storage-test", () => api.testPlatformStorage())}
        >
          {busy === "storage-test" ? "Testing…" : "Test connection"}
        </button>
      }
    >
      {!storage.configured ? (
        <Empty>
          Object storage is not configured. Set <code>S3_BUCKET</code> (and <code>S3_ENDPOINT</code> for R2).
        </Empty>
      ) : (
        <table>
          <tbody>
            <tr>
              <th>Endpoint</th>
              <td className="mono">{storage.endpoint ?? "AWS S3"}</td>
            </tr>
            <tr>
              <th>Bucket</th>
              <td className="mono">{storage.bucket}</td>
            </tr>
            <tr>
              <th>Region</th>
              <td className="mono">{storage.region}</td>
            </tr>
            <tr>
              <th>Access key</th>
              <td>
                <StatusBadge
                  status={STATUS[credential.status].badge}
                  label={STATUS[credential.status].label}
                />{" "}
                {credential.hint && <span className="mono">{credential.hint}</span>} ·{" "}
                {SOURCE_LABEL[credential.source]}
                {credential.version ? ` · v${credential.version}` : ""}
              </td>
            </tr>
            <tr>
              <th>Last test</th>
              <td>
                <TestOutcome test={credential.lastTest} />
              </td>
            </tr>
          </tbody>
        </table>
      )}
      {canStore && (
        <form className="row" onSubmit={save} autoComplete="off">
          <input
            required
            placeholder="Access key ID"
            value={accessKeyId}
            onChange={(e) => setAccessKeyId(e.target.value)}
          />
          <input
            required
            type="password"
            placeholder="Secret access key"
            value={secretAccessKey}
            onChange={(e) => setSecretAccessKey(e.target.value)}
          />
          <button type="submit" disabled={busy !== undefined}>
            {credential.source === "dashboard" ? "Rotate key" : "Save key"}
          </button>
          {credential.source === "dashboard" && credential.environmentFallback && (
            <button
              type="button"
              className="danger small"
              disabled={busy !== undefined}
              onClick={() => {
                if (!window.confirm("Remove the stored key and use the deployment environment's key?"))
                  return;
                void run("storage-revoke", () => api.revokePlatformCredential(credential.name));
              }}
            >
              Revoke
            </button>
          )}
        </form>
      )}
      {canStore && (
        <p className="muted">
          The new key is tested against the bucket before it replaces the current one. It is never shown
          again.
        </p>
      )}
    </Section>
  );
}

function MediaCard({ data, busy, run, setNotice }: CardProps) {
  const { media } = data;
  return (
    <Section
      title="Media providers (Multix)"
      actions={
        <button
          type="button"
          className="secondary"
          disabled={!media.executable.configured || busy !== undefined}
          onClick={() => void run("media-check", () => api.checkPlatformMultix())}
        >
          {busy === "media-check" ? "Checking…" : "Run multix check"}
        </button>
      }
    >
      <p className="muted">
        Executable:{" "}
        {media.executable.configured ? (
          <code>{media.executable.path}</code>
        ) : (
          (media.executable.reason ?? "MULTIX_BIN is not set")
        )}
      </p>
      {media.lastCheck && (
        <p className="muted">
          Last check: <TestOutcome test={media.lastCheck} />
          {media.lastCheck.found && media.lastCheck.found.length > 0 && (
            <> · found {media.lastCheck.found.join(", ")}</>
          )}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Vendor</th>
            <th>Used for</th>
            <th>Status</th>
            <th>Source</th>
            <th>Last test</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {media.vendors.map((vendor) => (
            <VendorRow
              key={vendor.name}
              vendor={vendor}
              canStore={data.secretStorage === "available"}
              busy={busy}
              run={run}
              setNotice={setNotice}
            />
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function VendorRow({
  vendor,
  canStore,
  busy,
  run,
  setNotice,
}: {
  vendor: PlatformCredential;
  canStore: boolean;
  busy?: string;
  run: Run;
  setNotice: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const status = STATUS[vendor.status];

  async function save(event: FormEvent) {
    event.preventDefault();
    const saved = await run(`save-${vendor.name}`, () =>
      api.savePlatformMediaKey(vendor.name, apiKey.trim()),
    );
    if (saved) {
      setApiKey("");
      setEditing(false);
      setNotice(`${vendor.label} key saved. It is never shown again.`);
    }
  }

  return (
    <tr>
      <td>{vendor.label}</td>
      <td>{vendor.kinds?.join(", ")}</td>
      <td>
        <StatusBadge status={status.badge} label={status.label} />
        {vendor.hint && <span className="mono"> {vendor.hint}</span>}
      </td>
      <td>
        {SOURCE_LABEL[vendor.source]}
        {vendor.version ? ` · v${vendor.version}` : ""}
      </td>
      <td>
        <TestOutcome test={vendor.lastTest} />
      </td>
      <td>
        {editing ? (
          <form className="row" onSubmit={save} autoComplete="off">
            <input
              required
              type="password"
              placeholder="API key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <button type="submit" className="small" disabled={busy !== undefined}>
              Save
            </button>
            <button type="button" className="secondary small" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <div className="row">
            {canStore && (
              <button type="button" className="secondary small" onClick={() => setEditing(true)}>
                {vendor.source === "dashboard" ? "Rotate" : "Add key"}
              </button>
            )}
            {vendor.source !== "none" && (
              <button
                type="button"
                className="secondary small"
                disabled={busy !== undefined}
                onClick={() => void run(`test-${vendor.name}`, () => api.testPlatformMediaKey(vendor.name))}
              >
                Test
              </button>
            )}
            {vendor.source === "dashboard" && (
              <button
                type="button"
                className="danger small"
                disabled={busy !== undefined}
                onClick={() => {
                  if (!window.confirm(`Revoke the ${vendor.label} key stored here?`)) return;
                  void run(`revoke-${vendor.name}`, () => api.revokePlatformCredential(vendor.name));
                }}
              >
                Revoke
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}
