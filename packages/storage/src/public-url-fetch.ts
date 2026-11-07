import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { StudixError } from "@studix/shared";
import { blockedAddressReason, guardedLookup } from "./endpoint-guard.ts";

const URL_POLICY = { allowLocal: false } as const;
const MAX_REDIRECTS = 3;

function refusedUrl(reason: string): StudixError {
  return new StudixError("VALIDATION", `The input URL was refused: ${reason}`, {
    retryable: false,
    details: { reason },
    suggestedAction: "Use a public https URL, or upload the file as base64.",
  });
}

/** Static URL checks before any connection: https, no credentials, no internal names or blocked IP literals. */
export function assertPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw refusedUrl("not a URL");
  }
  if (url.protocol !== "https:") throw refusedUrl("only https is allowed");
  if (url.username || url.password) throw refusedUrl("credentials in the URL");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || /\.(internal|local|localdomain|localhost)$/u.test(host)) {
    throw refusedUrl("internal host name");
  }
  if (isIP(host) && blockedAddressReason(host, URL_POLICY)) throw refusedUrl("private or reserved address");
  return url;
}

/**
 * Download a URL input through the SSRF guard: every hop is re-checked, the socket refuses private and
 * metadata addresses at connect time (DNS rebinding), and the body is capped.
 */
export async function fetchPublicUrl(raw: string, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  return (await fetchPublicUrlWithType(raw, maxBytes, signal)).body;
}

/** Same as `fetchPublicUrl`, plus the final response's Content-Type (without parameters), when it sent one. */
export async function fetchPublicUrlWithType(
  raw: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ body: Buffer; contentType?: string; url: URL }> {
  let url = assertPublicHttpsUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await new Promise<{
      status: number;
      location?: string;
      body?: Buffer;
      contentType?: string;
    }>((resolve, reject) => {
      const req = httpsRequest(
        url,
        { method: "GET", lookup: guardedLookup(URL_POLICY), signal, timeout: 60_000 },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            resolve({ status, location: res.headers.location });
            return;
          }
          if (status !== 200) {
            res.resume();
            reject(refusedUrl(`HTTP ${status}`));
            return;
          }
          const declared = Number(res.headers["content-length"] ?? 0);
          if (declared > maxBytes) {
            res.destroy();
            reject(refusedUrl("larger than the input limit"));
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("data", (c: Buffer) => {
            bytes += c.length;
            if (bytes > maxBytes) {
              res.destroy();
              reject(refusedUrl("larger than the input limit"));
              return;
            }
            chunks.push(c);
          });
          const type = String(res.headers["content-type"] ?? "")
            .split(";")[0]
            ?.trim()
            .toLowerCase();
          res.once("end", () =>
            resolve({ status, body: Buffer.concat(chunks), ...(type ? { contentType: type } : {}) }),
          );
          res.once("error", reject);
        },
      );
      req.once("timeout", () => req.destroy(new Error("timeout")));
      req.once("error", (err: NodeJS.ErrnoException) =>
        reject(
          err instanceof StudixError
            ? err
            : refusedUrl(
                err.code === "ESTORAGEBLOCKED" ? "private or reserved address" : "could not be fetched",
              ),
        ),
      );
      req.end();
    });
    if (response.body) {
      return {
        body: response.body,
        url,
        ...(response.contentType ? { contentType: response.contentType } : {}),
      };
    }
    url = assertPublicHttpsUrl(new URL(response.location as string, url).toString());
  }
  throw refusedUrl("too many redirects");
}
