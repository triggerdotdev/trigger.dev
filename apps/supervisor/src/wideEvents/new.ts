import { randomBytes } from "node:crypto";
import { parseTraceId } from "./traceparent.js";
import type { State } from "./state.js";

const MAX_REQUEST_ID_LEN = 128;

/**
 * Validates an inbound request id. Non-empty, no longer than 128 bytes,
 * composed entirely of visible ASCII (0x21..0x7E). Rejects newlines, control
 * characters, whitespace, DEL, high-bit bytes - any of which could poison the
 * log pipeline if echoed back verbatim.
 */
export function isValidRequestId(s: string): boolean {
  if (s.length === 0 || s.length > MAX_REQUEST_ID_LEN) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return false;
  }
  return true;
}

/**
 * Service-level identity that's constant for the lifetime of the process.
 * Populated once at startup, copied into every State.
 */
export type Env = {
  version?: string;
  commitSha?: string;
  region?: string;
  nodeId?: string;
};

export type NewStateOptions = {
  service: string;
  env: Env;
  /** Optional inbound request id (e.g. from `x-request-id`). If unsafe or absent, a fresh `req-<hex>` is minted. */
  inboundRequestId?: string;
  /** Optional inbound W3C traceparent (HTTP header, queue message field). */
  traceparent?: string;
};

/**
 * Builds a State for a wide-event lifecycle.
 *
 *   - requestId: honours `inboundRequestId` if present and safe; otherwise
 *     mints a fresh `req-<hex>` id.
 *   - traceId: parsed from the provided traceparent (graceful empty if
 *     absent or malformed).
 *   - traceparent: preserved verbatim for downstream propagation.
 */
export function newState(opts: NewStateOptions): State {
  const traceparent = opts.traceparent ?? "";
  const inbound = opts.inboundRequestId ?? "";
  const requestId = isValidRequestId(inbound) ? inbound : newRequestId();

  return {
    requestId,
    traceId: parseTraceId(traceparent),
    traceparent,
    service: opts.service,
    version: opts.env.version,
    commitSha: opts.env.commitSha,
    region: opts.env.region,
    nodeId: opts.env.nodeId,
    meta: {},
    phases: [],
    ok: false,
    statusCode: 0,
    durationMs: 0,
    extras: {},
  };
}

function newRequestId(): string {
  return "req-" + randomBytes(16).toString("hex");
}
