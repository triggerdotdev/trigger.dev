/**
 * cf-trust-test proxy. Validates that a trusted edge proxy can inject a
 * namespaced metadata field (`__cf`) into trigger.dev's chat session-create
 * and follow-up message wire payloads — and that the trigger.dev server passes
 * it through to the agent untouched.
 *
 * Local dev: `wrangler dev` exposes the worker on http://localhost:8787 and
 * forwards to TRIGGER_API_UPSTREAM. With `wrangler dev --remote` the worker
 * runs on the CF edge and `request.cf` is populated with real signals; the
 * --local default leaves request.cf undefined, so we fall back to hardcoded
 * trust values that prove the plumbing without depending on a real CF edge.
 */

export interface Env {
  TRIGGER_API_UPSTREAM: string;
}

type CfTrustData = {
  botScore: number;
  ja4: string;
  asn: number;
  country: string;
};

function readCfTrustData(request: Request): CfTrustData {
  const cf = (request as Request & { cf?: Record<string, unknown> }).cf;
  const bm = (cf?.botManagement as Record<string, unknown> | undefined) ?? undefined;
  return {
    botScore: (bm?.score as number | undefined) ?? 95,
    ja4: (bm?.ja4 as string | undefined) ?? "t13d1715h2_5b57614c22b0_5c2c4ed3e2d9",
    asn: (cf?.asn as number | undefined) ?? 13335,
    country: (cf?.country as string | undefined) ?? "US",
  };
}

function withCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  const origin = request.headers.get("origin") ?? "*";
  const reqHeaders = request.headers.get("access-control-request-headers");
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
  if (reqHeaders) headers.set("Access-Control-Allow-Headers", reqHeaders);
  headers.set("Access-Control-Expose-Headers", "*");
  headers.set("Access-Control-Allow-Credentials", "true");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function handlePreflight(request: Request): Response {
  return withCors(new Response(null, { status: 204 }), request);
}

function setCfNamespace(
  metadata: Record<string, unknown> | undefined,
  cf: CfTrustData
): Record<string, unknown> {
  const stripped: Record<string, unknown> = { ...(metadata ?? {}) };
  delete stripped.__cf;
  return { ...stripped, __cf: cf };
}

async function rewriteSessionCreateBody(body: string, cf: CfTrustData): Promise<string> {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  const triggerConfig = (parsed.triggerConfig as Record<string, unknown> | undefined) ?? {};
  const basePayload = (triggerConfig.basePayload as Record<string, unknown> | undefined) ?? {};
  const metadata = basePayload.metadata as Record<string, unknown> | undefined;
  parsed.triggerConfig = {
    ...triggerConfig,
    basePayload: { ...basePayload, metadata: setCfNamespace(metadata, cf) },
  };
  return JSON.stringify(parsed);
}

async function rewriteAppendBody(body: string, cf: CfTrustData): Promise<string> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return body;
  }
  if (parsed.kind !== "message") return body;
  const payload = (parsed.payload as Record<string, unknown> | undefined) ?? {};
  const metadata = payload.metadata as Record<string, unknown> | undefined;
  parsed.payload = { ...payload, metadata: setCfNamespace(metadata, cf) };
  return JSON.stringify(parsed);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return handlePreflight(request);

    const upstream = new URL(env.TRIGGER_API_UPSTREAM);
    const incoming = new URL(request.url);
    const target = new URL(incoming.pathname + incoming.search, upstream);

    const cf = readCfTrustData(request);
    const isAppend =
      request.method === "POST" &&
      /^\/realtime\/v1\/sessions\/[^/]+\/in\/append$/.test(incoming.pathname);
    const isSessionsCreate =
      request.method === "POST" && incoming.pathname === "/api/v1/sessions";

    let body: BodyInit | null = null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const raw = await request.text();
      if (isSessionsCreate && raw) body = await rewriteSessionCreateBody(raw, cf);
      else if (isAppend && raw) body = await rewriteAppendBody(raw, cf);
      else body = raw;
    }

    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");

    const upstreamResponse = await fetch(target.toString(), {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    });

    return withCors(upstreamResponse, request);
  },
};
