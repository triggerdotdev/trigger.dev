import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { logger } from "~/services/logger.server";

// Same-origin reverse proxy for PostHog. posthog-js sets `api_host: "/ph"`, so
// analytics is served first-party and forwarded to PostHog Cloud server-side.
// Asset requests (recorder script, array bundles) go to the assets host and
// everything else (ingest, feature flags, session recording) to the ingest
// host, as PostHog's reverse-proxy docs require. Streaming and header handling
// mirror the Electric proxy in longPollingFetch.ts.

const PH_PREFIX = "/ph";

function isAssetPath(upstreamPath: string): boolean {
  return upstreamPath.startsWith("/static/") || upstreamPath.startsWith("/array/");
}

async function proxyToPostHog(request: Request): Promise<Response> {
  const url = new URL(request.url);

  const upstreamPath = url.pathname.slice(PH_PREFIX.length) || "/";
  const hostname = isAssetPath(upstreamPath) ? env.POSTHOG_ASSETS_HOST : env.POSTHOG_INGEST_HOST;
  const upstreamUrl = `https://${hostname}${upstreamPath}${url.search}`;

  const headers = new Headers(request.headers);
  // PostHog routes on Host, so point it at the upstream. accept-encoding is
  // dropped so we don't get a compressed body we'd have to re-describe.
  headers.set("host", hostname);
  headers.delete("accept-encoding");

  // /ph is same-origin, so the browser sends every first-party cookie. Forward
  // only PostHog's own so we never leak the app session cookie to a third party.
  const cookie = headers.get("cookie");
  if (cookie) {
    const forwarded = cookie
      .split(";")
      .filter((c) => {
        const name = c.trimStart().split("=", 1)[0];
        return name.startsWith("ph_") || name.startsWith("__ph");
      })
      .join(";");

    if (forwarded) {
      headers.set("cookie", forwarded);
    } else {
      headers.delete("cookie");
    }
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  // `duplex` isn't in the DOM RequestInit lib types but undici needs it to
  // stream a request body; widen the type rather than suppress.
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    signal: getRequestAbortSignal(),
    duplex: hasBody ? "half" : undefined,
  };

  let upstream: Response | undefined;
  try {
    upstream = await fetch(upstreamUrl, init);

    // Strip encoding headers that can misdescribe the proxied body (see longPollingFetch).
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    try {
      await upstream?.body?.cancel();
    } catch {}

    if (error instanceof Error && error.name === "AbortError") {
      throw new Response(null, { status: 499 });
    }

    logger.error("[posthog-proxy] fetch error", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Response("PostHog proxy error", { status: 502 });
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  return proxyToPostHog(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return proxyToPostHog(request);
}
