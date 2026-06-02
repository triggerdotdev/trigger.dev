import type { State } from "./state.js";
import { truncateUtf8 } from "./truncate.js";

/**
 * Stable slog message string for every wide event. Downstream filters (jq,
 * Axiom queries, Vector pipelines) pin to this constant. The `service` field
 * disambiguates which service emitted it.
 */
export const EmitMessage = "wide_event";

const MAX_ERROR_MSG_BYTES = 512;

/**
 * Serializes a State as a single flat-keyed JSON line on stdout. Keys are
 * flat (no nested objects) to keep jq filtering and Axiom indexing cheap.
 * Empty optional fields are omitted.
 */
export function emit(state: State): void {
  // Best-effort: an observability failure (serialization, stdout write) must
  // never break or mask the caller's operation. Every call site relies on this.
  try {
    const out: Record<string, unknown> = {
      msg: EmitMessage,
      request_id: state.requestId,
    };

    if (state.traceId) out.trace_id = state.traceId;
    appendIfSet(out, "start_time", state.startTime);
    appendIfSet(out, "service", state.service);
    appendIfSet(out, "version", state.version);
    appendIfSet(out, "commit_sha", state.commitSha);
    appendIfSet(out, "region", state.region);
    appendIfSet(out, "node_id", state.nodeId);

    appendIfSet(out, "op", state.op);
    appendIfSet(out, "kind", state.kind);

    out.ok = state.ok;
    if (state.statusCode !== 0) out.status = state.statusCode;
    out.duration_ms = state.durationMs;

    if (state.error) {
      appendIfSet(out, "error.code", state.error.code);
      appendIfSet(out, "error.message", truncateUtf8(state.error.message, MAX_ERROR_MSG_BYTES));
      appendIfSet(out, "error.kind", state.error.kind);
    }

    for (const [k, v] of Object.entries(state.meta)) {
      out["meta." + k] = v;
    }

    for (const p of state.phases) {
      const prefix = "phase." + p.name + ".";
      out[prefix + "duration_ms"] = p.durationMs;
      out[prefix + "ok"] = p.ok;
      out[prefix + "attempts"] = p.attempts;
      if (p.errorCode) out[prefix + "error_code"] = p.errorCode;
      if (p.errorMsg) out[prefix + "error_message"] = p.errorMsg;
      if (p.sub) {
        for (const [sk, sv] of Object.entries(p.sub)) {
          out[prefix + sk] = sv;
        }
      }
    }

    for (const [k, v] of Object.entries(state.extras)) {
      out[k] = v;
    }

    process.stdout.write(JSON.stringify(out) + "\n");
  } catch (err) {
    try {
      process.stderr.write(
        `wide_event_emit_failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
    } catch {
      // last resort - drop the event rather than throw
    }
  }
}

function appendIfSet(out: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value) out[key] = value;
}
