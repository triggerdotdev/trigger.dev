import { json } from "@remix-run/server-runtime";
import { getMeter } from "@internal/tracing";
import { singleton } from "~/utils/singleton";
import {
  SecretProxyDeniedError,
  type SecretProxyService,
  SECRET_PROXY_MAX_REQUEST_BYTES,
} from "./service.server";
import { z } from "zod";
import { logger } from "../logger.server";
import { recordSecretProxyFailure, type SecretProxyFailureReason } from "./telemetry.server";

const headers = { "Cache-Control": "no-store", Pragma: "no-cache" };
const resolutionDuration = singleton("secretProxyResolutionDuration", () =>
  getMeter("secret-proxy").createHistogram("secret_proxy.resolve.duration_ms", {
    description: "Secret proxy resolution duration by outcome",
    unit: "ms",
  })
);

async function boundedJson(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    throw new Response("Expected JSON", { status: 415, headers });
  }
  const reader = request.body?.getReader();
  if (!reader) throw new Response("Missing body", { status: 400, headers });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SECRET_PROXY_MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new Response("Request too large", { status: 413, headers });
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}

export async function resolveSecretProxyRequest(service: SecretProxyService, request: Request) {
  const startedAt = performance.now();
  const response = await resolveRequest(service, request);
  const fields = {
    status: response.status,
    outcome:
      response.status === 200 ? "resolved" : response.status >= 500 ? "unavailable" : "denied",
    durationMs: performance.now() - startedAt,
  };
  resolutionDuration.record(fields.durationMs, { status: fields.status, outcome: fields.outcome });
  // The logger supplies HTTP request context. Never attach input, tokens, or caught errors here.
  if (response.status >= 500) logger.warn("Secret proxy resolution", fields);
  return response;
}

function failure(
  reason: SecretProxyFailureReason,
  error: string,
  status: number,
  details?: Record<string, unknown>
) {
  recordSecretProxyFailure("resolve", reason);
  return json({ error, ...details }, { status, headers });
}

async function resolveRequest(service: SecretProxyService, request: Request) {
  const serviceToken = request.headers.get("x-trigger-secret-proxy-token");
  // Check the internal service credential before reading the body or examining a run token.
  if (!service.serviceAuthenticated(serviceToken)) {
    return failure("service_auth", "Unauthorized service", 401);
  }
  if (request.method !== "POST") return failure("policy", "Method not allowed", 405);
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return failure("token", "Invalid run token", 401);
  try {
    const body = await boundedJson(request);
    const result = await service.resolve(serviceToken, authorization.slice(7), body);
    return json(result, { headers });
  } catch (error) {
    if (error instanceof Response) {
      recordSecretProxyFailure("resolve", error.status === 413 ? "limit" : "policy");
      return error;
    }
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return failure("policy", "Invalid request or policy", 400);
    }
    if (error instanceof SecretProxyDeniedError) {
      // "selection": the run is valid and only the listed selections are refused. Any other
      // 403, including from resolvers without a scope, denies the whole run.
      return failure(
        error.reason,
        "Resolution denied",
        403,
        error.selections ? { scope: "selection", selections: error.selections } : { scope: "run" }
      );
    }
    return failure("dependency", "Secret resolution unavailable", 503);
  }
}
