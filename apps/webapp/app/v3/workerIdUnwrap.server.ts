// Decodes a `worker_id` that may be a deployment token back to its friendlyId, so the stored/queried
// value stays a short, stable id. Runs on the OTEL ingest hot path: base64url + JSON decode only (no
// verify), LRU-memoized. Fails safe — a non-token value passes through unchanged.

import { LRUCache } from "lru-cache";
import { SemanticInternalAttributes } from "@trigger.dev/core/v3";

// The runner flattens `worker.id` (the raw TRIGGER_DEPLOYMENT_ID) into span/log metadata under this
// key, mirroring how the runner composes it, so it can't drift.
const WORKER_ID_METADATA_KEY = `${SemanticInternalAttributes.METADATA}.${SemanticInternalAttributes.WORKER_ID}`;

/**
 * Unwrap, in place, the `worker.id` a runner stamps into span/log metadata: a deployment-token value
 * becomes its friendlyId, everything else is left untouched. Keeps the credential out of stored
 * telemetry and the value a stable deployment id (the metrics path unwraps its own worker_id).
 */
export function unwrapWorkerIdInMetadata<
  T extends Record<string, string | number | boolean | undefined>,
>(metadata: T | undefined): T | undefined {
  if (metadata) {
    const value = metadata[WORKER_ID_METADATA_KEY];
    if (typeof value === "string") {
      (metadata as Record<string, string | number | boolean | undefined>)[WORKER_ID_METADATA_KEY] =
        unwrapWorkerId(value);
    }
  }
  return metadata;
}

// LRU, not FIFO: the active-deployment working set is unbounded, so an insertion-order memo thrashes
// once it exceeds the cap. Raw lru-cache (not @internal/cache's async wrapper) since this is sync.
const memo = new LRUCache<string, string>({ max: 32_768 });

export function unwrapWorkerId(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }

  // Fast path: a minted token is a JWT, whose base64url header always begins "eyJ". Anything else —
  // a bare deployment friendlyId, "unmanaged", a dev id — returns immediately with no decode and no
  // memo entry, so the non-token case costs nothing (and stays free once telemetry no longer carries
  // tokens at all).
  if (!value.startsWith("eyJ")) {
    return value;
  }

  const cached = memo.get(value);
  if (cached !== undefined) {
    return cached;
  }

  const unwrapped = decodeDeploymentFriendlyId(value) ?? value;
  memo.set(value, unwrapped);

  return unwrapped;
}

function decodeDeploymentFriendlyId(value: string): string | undefined {
  const parts = value.split(".");
  // Not a JWT (three non-empty segments) → a legacy bare friendlyId; leave it as-is.
  if (parts.length !== 3 || !parts[1]) {
    return undefined;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      deployment?: unknown;
    };
    return typeof payload.deployment === "string" && payload.deployment.length > 0
      ? payload.deployment
      : undefined;
  } catch {
    return undefined;
  }
}
