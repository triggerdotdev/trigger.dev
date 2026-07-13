import http from "node:http";
import https from "node:https";
import { promises as dnsPromises } from "node:dns";
import type { LookupFunction } from "node:net";
import { logger } from "~/services/logger.server";
import {
  assertAddressAllowed,
  assertSafeWebhookUrl,
  assertSafeWebhookUrlLexical,
  UnsafeWebhookUrlError,
} from "./safeWebhookUrl.server";

/**
 * `fetch`-like wrapper for delivering user-supplied webhook URLs. The lexical
 * check is shared with the storage-time gate (`assertSafeWebhookUrlLexical`).
 *
 * Validation is bound to the actual connection: the request goes through
 * `node:http`/`node:https` with a custom DNS `lookup` that validates every
 * resolved address before the socket connects, so the connected address is the
 * one that was checked. Redirects are followed manually and re-validated per
 * hop, capped at `MAX_REDIRECTS`.
 */

// Re-exported so callers/tests don't reach into the underlying module.
export { assertSafeWebhookUrl, assertSafeWebhookUrlLexical, UnsafeWebhookUrlError };

const MAX_REDIRECTS = 5;

export type SafeWebhookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  signal?: AbortSignal;
  redirectLimit?: number;
};

// DNS lookup that validates every resolved address before handing it to the
// connector; any unsafe address fails the whole lookup. On error we pass an
// empty address list, which net ignores when err is set.
const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsPromises
    .lookup(hostname, {
      all: true,
      family: options.family,
      hints: options.hints,
      verbatim: options.verbatim,
    })
    .then((addresses) => {
      try {
        for (const { address, family } of addresses) {
          assertAddressAllowed(address, family);
        }
      } catch (err) {
        callback(err as NodeJS.ErrnoException, []);
        return;
      }
      if (options.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0].address, addresses[0].family);
      }
    })
    .catch((err) => callback(err as NodeJS.ErrnoException, []));
};

// Single request with no redirect following, using the validating lookup. The
// response body is drained and discarded (callers only need status / headers),
// which also frees the socket.
function requestOnce(urlStr: string, init: SafeWebhookFetchInit): Promise<Response> {
  const url = new URL(urlStr);
  const mod = url.protocol === "https:" ? https : http;
  // Set Content-Length explicitly (as fetch does for string/Buffer bodies)
  // rather than falling back to chunked transfer-encoding, which some
  // webhook receivers reject.
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (
    init.body != null &&
    headers["content-length"] === undefined &&
    headers["Content-Length"] === undefined
  ) {
    headers["content-length"] = String(Buffer.byteLength(init.body));
  }
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: init.method ?? "GET",
        headers,
        lookup: safeLookup,
        signal: init.signal,
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) {
              for (const v of value) responseHeaders.append(key, v);
            } else if (value !== undefined) {
              responseHeaders.set(key, value);
            }
          }
          resolve(
            new Response(null, {
              status: res.statusCode ?? 502,
              statusText: res.statusMessage ?? "",
              headers: responseHeaders,
            })
          );
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    if (init.body != null) {
      req.write(init.body);
    }
    req.end();
  });
}

/**
 * Tenant-supplied-URL fetch with connection-bound SSRF validation and manual,
 * per-hop redirect validation.
 */
export async function safeWebhookFetch(
  rawUrl: string,
  init: SafeWebhookFetchInit = {}
): Promise<Response> {
  let nextUrl = assertSafeWebhookUrlLexical(rawUrl).href;
  const limit = init.redirectLimit ?? MAX_REDIRECTS;

  for (let hop = 0; hop <= limit; hop++) {
    const response = await requestOnce(nextUrl, init);
    if (response.status < 300 || response.status >= 400) {
      return response;
    }
    const location = response.headers.get("location");
    if (!location) return response;
    if (hop === limit) {
      throw new UnsafeWebhookUrlError(
        `Refusing to deliver webhook to ${nextUrl}: exceeded redirect limit (${limit}) following ${location}`
      );
    }
    const target = new URL(location, nextUrl);
    try {
      nextUrl = assertSafeWebhookUrlLexical(target.href).href;
    } catch (err) {
      logger.warn("Refusing to follow webhook redirect", {
        from: nextUrl,
        to: target.href,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
  // Unreachable — the loop always returns or throws.
  throw new UnsafeWebhookUrlError(
    `Refusing to deliver webhook to ${nextUrl}: exhausted redirect loop`
  );
}
