import type {
  ReadScope,
  ScopedReadKind,
  SourceReadLedger,
  SourceReadLookup,
} from "./tool-source-ledger";

/** The errors API returns "error_<fingerprint>", but the ledger and URIs key on the raw one. */
export function bareFingerprint(id: string): string {
  return id.replace(/^error_/, "");
}

/** Records a read against the ledger, deduped and keyed the same way regardless of
 * which tool observed it. */
export function recordRead(
  reads: SourceReadLookup & Pick<SourceReadLedger, "recordTraceSpans" | "recordScopedRead">,
  kind: "run" | ScopedReadKind,
  id: string,
  scope: ReadScope
): void {
  if (kind === "run") {
    reads.recordTraceSpans(id, scope);
  } else {
    reads.recordScopedRead(kind, kind === "error" ? bareFingerprint(id) : id, scope);
  }
}
