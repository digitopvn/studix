import { type FormEvent, useState } from "react";
import {
  api,
  type PlatformCredential,
  type PlatformMediaTest,
  type PlatformMediaVendor,
  type PlatformSettings,
  type PlatformStorageTest,
} from "../api-client.ts";
import { Empty, ErrorBanner, formatDate, Section, StatusBadge, useAsync } from "../ui.tsx";

const SECRET_LABELS: Record<PlatformSettings["storage"]["secretAccessKey"], string> = {
  configured: "Configured",
  missing: "Missing",
  invalid: "Invalid",
  unverified: "Unverified",
};

const SOURCE_LABELS: Record<PlatformCredential["source"], string> = {
  dashboard: "Set here",
  environment: "From the environment",
  missing: "Missing",
};

const STORAGE_DIAGNOSIS: Record<PlatformStorageTest["diagnosis"], string> = {
  ok: "Passed",
  missing_credential: "Missing credential",
  bad_credential: "Bad credential",
  missing_permission: "Missing permission",
  missing_bucket: "Bucket not found",
  remote_unavailable: "Remote unavailable",
};

const MEDIA_DIAGNOSIS: Record<PlatformMediaTest["diagnosis"], string> = {
  ok: "Passed",
  missing_executable: "Missing executable",
  missing_credential: "Missing credential",
  check_failed: "Check failed",
};

/**
 * Platform operator settings: object storage (R2) status and a real read/write check, and the media vendor
 * keys the Multix CLI uses. Keys are typed into a password field, sent once and never shown again: after
 * saving, only a hint, the owner and the last test remain.
 */
export function StorageMediaPage() {
  const { data, error, reload } = useAsync(() => api.platformSettings());
  return (
    <>
      <ErrorBanner error={error} />
      {data && <StorageCard storage={data.storage} reload={reload} />}
      {data && <MediaCard media={data.media} reload={reload} />}
    </>
  );
}

function StorageCard({ storage, reload }: { storage: PlatformSettings["storage"]; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>();

  async function test() {
    setActionError(undefined);
    setBusy(true);
    try {
      await api.testPlatformStorage();
      reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  const last = storage.lastTest;
  return (
    <Section
      title="Object storage (Cloudflare R2)"
      actions={
        <button type="button" disabled={busy || !storage.configured} onClick={test}>
          {busy ? "Testing…" : "Test connection"}
        </button>
      }
    >
      <p className="muted">
        The bucket is shared by every workspace, each under its own prefix. The values below come from the
        deployment settings; the secret key is never stored or shown here. To rotate it, update
        <code> S3_ACCESS_KEY_ID</code> and <code>S3_SECRET_ACCESS_KEY</code> in the deployment and redeploy
        the app and the worker, then run the test.
      </p>
      <ErrorBanner error={actionError} />
      <table>
        <tbody>
          <tr>
            <th>Endpoint</th>
            <td className="mono">{storage.endpointHost ?? "-"}</td>
          </tr>
          <tr>
            <th>Bucket</th>
            <td className="mono">{storage.bucket ?? "Not configured"}</td>
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
              <StatusBadge status={storage.secretAccessKey} label={SECRET_LABELS[storage.secretAccessKey]} />
            </td>
          </tr>
          <tr>
            <th>Last test</th>
            <td>
              {last ? (
                <>
                  <StatusBadge
                    status={last.ok ? "available" : "failed"}
                    label={STORAGE_DIAGNOSIS[last.diagnosis]}
                  />{" "}
                  {formatDate(last.at)}
                  {!last.ok && (
                    <div className="muted">
                      {last.failedStep ? `Failed at ${last.failedStep}` : "Failed"}
                      {last.httpStatus ? ` · HTTP ${last.httpStatus}` : ""}
                      {last.s3Code ? ` · ${last.s3Code}` : ""}
                      {last.suggestedAction ? ` — ${last.suggestedAction}` : ""}
                    </div>
                  )}
                </>
              ) : (
                "Never"
              )}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="muted">
        The test writes, reads, checks and deletes one small temporary object under a probe prefix of this
        bucket.
      </p>
    </Section>
  );
}

function MediaCard({ media, reload }: { media: PlatformSettings["media"]; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const [result, setResult] = useState<PlatformMediaTest>();

  async function check() {
    setActionError(undefined);
    setBusy(true);
    try {
      setResult(await api.testPlatformMedia());
      reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Media providers (Multix)"
      actions={
        <button type="button" disabled={busy} onClick={check}>
          {busy ? "Checking…" : "Run safe check"}
        </button>
      }
    >
      <p className="muted">
        Studix passes these vendor keys to the Multix CLI. The safe check only reads which keys exist; it
        calls no paid provider. {media.apply.keyChange}
      </p>
      <ErrorBanner error={actionError} />
      {media.credentialStorage === "unavailable" && (
        <p className="banner banner-error">
          Keys cannot be stored until STUDIX_SECRETS_KEY is set on the app and the worker.
        </p>
      )}
      <table>
        <tbody>
          <tr>
            <th>Multix executable</th>
            <td>
              <StatusBadge
                status={media.executable === "configured" ? "available" : "missing"}
                label={media.executable === "configured" ? "Configured" : "Missing"}
              />{" "}
              <span className="mono">{media.path ?? ""}</span>
              {media.executable === "missing" && <div className="muted">{media.apply.executableChange}</div>}
            </td>
          </tr>
          <tr>
            <th>Home env file</th>
            <td>
              {media.homeEnvDisabled ? "Ignored (MULTIX_DISABLE_HOME_ENV=1)" : "Read (development only)"}
            </td>
          </tr>
          <tr>
            <th>Last check</th>
            <td>
              {media.lastCheck ? (
                <>
                  {formatDate(media.lastCheck.at)} · {media.lastCheck.state.replace(/_/g, " ")}
                  {media.lastCheck.reason ? ` — ${media.lastCheck.reason}` : ""}
                </>
              ) : (
                "Never"
              )}
            </td>
          </tr>
        </tbody>
      </table>
      {result && (
        <p className={`banner ${result.ok ? "" : "banner-error"}`} role="status">
          {MEDIA_DIAGNOSIS[result.diagnosis]}
          {result.reason ? `: ${result.reason}` : ""}
        </p>
      )}
      <p className="muted">{media.processNote}</p>
      {media.worker && !media.worker.reachable && (
        <p className="banner banner-error" role="status">
          The worker health endpoint did not answer, so its media status is unknown.
        </p>
      )}
      {media.worker?.reachable && !media.worker.report && (
        <p className="muted">The worker has not reported its media status yet.</p>
      )}
      {media.worker && media.worker.mismatches.length > 0 && (
        <div className="banner banner-error" role="status">
          The app and the worker disagree:
          <ul>
            {media.worker.mismatches.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      {media.worker?.report && media.worker.mismatches.length === 0 && (
        <p className="muted">
          Worker: Multix {media.worker.report.executable}, check{" "}
          {media.worker.report.state.replace(/_/g, " ")}; it matches the app.
        </p>
      )}
      {media.vendors.length === 0 ? (
        <Empty>No media providers.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Provider key</th>
              <th>Serves</th>
              <th>Source</th>
              <th>Check</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {media.vendors.map((v) => (
              <VendorRow
                key={v.keyName}
                vendor={v}
                canStore={media.credentialStorage === "available"}
                reload={reload}
              />
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function VendorRow({
  vendor,
  canStore,
  reload,
}: {
  vendor: PlatformMediaVendor;
  canStore: boolean;
  reload: () => void;
}) {
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const credential = vendor.credential;

  async function act(action: () => Promise<unknown>) {
    setActionError(undefined);
    setBusy(true);
    try {
      await action();
      reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const key = value.trim();
    // The secret leaves component state as soon as it is sent, whether or not the server accepts it.
    setValue("");
    await act(async () => {
      await api.setPlatformMediaKey(vendor.keyName, key);
      setEditing(false);
    });
  }

  async function revoke() {
    if (
      !window.confirm(
        `Remove ${vendor.keyName} from Studix? The key is not revoked at the provider; revoke it there if it should stop working.`,
      )
    ) {
      return;
    }
    await act(() => api.revokePlatformMediaKey(vendor.keyName));
  }

  return (
    <tr>
      <td>
        <span className="mono">{vendor.keyName}</span>
        {credential.keyHint && <div className="mono muted">{credential.keyHint}</div>}
        <ErrorBanner error={actionError} />
        {editing && (
          <form className="row" onSubmit={save}>
            <input
              required
              type="password"
              autoComplete="new-password"
              aria-label={`${vendor.keyName} value`}
              placeholder="Paste the new key"
              value={value}
              disabled={busy}
              onChange={(e) => setValue(e.target.value)}
            />
            <button type="submit" disabled={busy}>
              Save
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setValue("");
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </form>
        )}
      </td>
      <td>{vendor.kinds.join(", ")}</td>
      <td>
        <StatusBadge
          status={credential.source === "missing" ? "missing" : "configured"}
          label={SOURCE_LABELS[credential.source]}
        />
      </td>
      <td>
        <StatusBadge
          status={vendor.status === "configured" ? "available" : vendor.status}
          label={vendor.status === "configured" ? "Key found" : vendor.status}
        />
      </td>
      <td>
        {credential.updatedAt ? formatDate(credential.updatedAt) : "-"}
        {credential.updatedBy && <div className="muted">by {credential.updatedBy.id}</div>}
      </td>
      <td>
        {canStore && !editing && (
          <button type="button" disabled={busy} onClick={() => setEditing(true)}>
            {credential.source === "dashboard" ? "Rotate" : "Set key"}
          </button>
        )}{" "}
        {credential.source === "dashboard" && (
          <button type="button" disabled={busy} onClick={revoke}>
            Revoke
          </button>
        )}
      </td>
    </tr>
  );
}
