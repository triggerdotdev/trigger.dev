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
  /** Operation discriminator. Dotted `noun.verb`. Defaults to empty (set later). */
  op?: string;
  /** Event shape: `inbound` | `outbound` | `event` | `scheduled`. Defaults to empty. */
  kind?: string;
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
    startTime: nowRfc3339(),
    requestId,
    traceId: parseTraceId(traceparent),
    traceparent,
    service: opts.service,
    version: opts.env.version,
    commitSha: opts.env.commitSha,
    region: opts.env.region,
    nodeId: opts.env.nodeId,
    op: opts.op ?? "",
    kind: opts.kind ?? "",
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

/**
 * Current wall-clock time as an RFC3339 string with microsecond precision.
 * `Date.toISOString()` only has millisecond resolution, which is too coarse to
 * order multiple wide events emitted within the same millisecond.
 * `performance.timeOrigin + performance.now()` gives a sub-millisecond wall-clock
 * reading; we append the microsecond digits to the millisecond ISO string.
 */
function nowRfc3339(): string {
  const ms = performance.timeOrigin + performance.now();
  const micros = Math.floor((ms % 1) * 1000); // microseconds within the millisecond (0..999)
  return new Date(ms).toISOString().slice(0, -1) + String(micros).padStart(3, "0") + "Z";
}
