import {
  formatTriggerUri,
  safeParseTriggerUri,
  type Evidence,
  type EvidenceRef,
  type InvestigationState,
  type InvestigationStateInput,
  type ParsedTriggerUri,
} from "@internal/dashboard-agent-contracts";
import type { SourceReadLookup } from "./tool-source-ledger";

export type EvidenceScope = { projectRef: string; environmentId: string };

/**
 * Builds the canonical `trigger://` URI for a cited ref. A ref that can't be
 * canonicalized is returned as a named error, never dropped.
 */
function canonicalizeEvidence(
  items: EvidenceRef[],
  scope: EvidenceScope,
  reads: SourceReadLookup
): { evidence: Evidence[]; errors: string[] } {
  const evidence: Evidence[] = [];
  const errors: string[] = [];
  const base = { projectRef: scope.projectRef, environmentId: scope.environmentId };

  for (const item of items) {
    if (item.kind === "span") {
      evidence.push({
        kind: "span",
        label: item.label,
        ...(item.excerpt === undefined ? {} : { excerpt: item.excerpt }),
        uri: formatTriggerUri({
          ...base,
          kind: "span",
          runId: item.runId.trim(),
          spanId: item.spanId.trim(),
        }),
      });
      continue;
    }

    if (item.kind === "source") {
      const path = item.path.trim().replace(/^\/+/, "");
      // The commit comes from this turn's read ledger and nowhere else: the turn's
      // snapshot sha is not proof of reading.
      const claimed = item.sha?.trim();
      if (claimed && !reads.wasReadThisTurn(path, claimed)) {
        errors.push(
          `source "${path}" wasn't read at commit ${claimed.slice(
            0,
            7
          )} — read_file it at that commit, or cite the commit you did read it at`
        );
        continue;
      }
      const sha = claimed || reads.shaForReadPath(path);
      if (!sha) {
        errors.push(
          `source "${path}" wasn't read this turn — read it with read_file first, then cite it`
        );
        continue;
      }
      evidence.push({
        kind: "source",
        label: item.label,
        ...(item.excerpt === undefined ? {} : { excerpt: item.excerpt }),
        uri: formatTriggerUri({
          ...base,
          kind: "source",
          sha,
          path,
          ...(item.line === undefined ? {} : { line: item.line }),
        }),
      });
      continue;
    }

    let ref = item.uri.trim();

    // Already a full URI: kind and scope both have to match, so a URI from another
    // scope can't be smuggled in.
    const asUri = safeParseTriggerUri(ref);
    if (asUri.success) {
      const parsedUri = asUri.data;
      if (parsedUri.kind !== item.kind) {
        errors.push(`${item.kind} evidence cites a ${parsedUri.kind} URI (${ref})`);
        continue;
      }
      if (
        parsedUri.projectRef !== scope.projectRef ||
        parsedUri.environmentId !== scope.environmentId
      ) {
        errors.push(`${ref} belongs to a different project or environment`);
        continue;
      }
      // A canonical URI never carries the friendly "error_" prefix.
      const normalizedUri =
        parsedUri.kind === "error"
          ? { ...parsedUri, fingerprint: parsedUri.fingerprint.replace(/^error_/, "") }
          : parsedUri;
      evidence.push({ ...item, uri: formatTriggerUri(normalizedUri) });
      continue;
    }

    // An improvised almost-URI: salvage the bare id from the last path segment.
    if (ref.includes("://")) {
      const segments = ref.split("?")[0]!.split("/").filter(Boolean);
      const last = segments[segments.length - 1];
      if (!last || last.includes(":")) {
        errors.push(`${item.kind} evidence "${ref}" isn't a resource id`);
        continue;
      }
      ref = last;
    }

    let parsed: ParsedTriggerUri;
    switch (item.kind) {
      case "run":
        parsed = { ...base, kind: "run", runId: ref };
        break;
      case "error":
        // The errors API returns "error_<fingerprint>" but the URI keys on the raw one.
        parsed = { ...base, kind: "error", fingerprint: ref.replace(/^error_/, "") };
        break;
      case "queue":
        parsed = { ...base, kind: "queue", name: ref };
        break;
      case "deployment":
        parsed = { ...base, kind: "deployment", version: ref };
        break;
      case "report":
        parsed = { ...base, kind: "report", key: ref };
        break;
      case "investigation":
        parsed = { ...base, kind: "investigation", investigationId: ref };
        break;
      case "runs":
        parsed = { ...base, kind: "runs" };
        break;
    }
    evidence.push({ ...item, uri: formatTriggerUri(parsed) });
  }

  return { evidence, errors };
}

export function canonicalizeInvestigationState(
  state: InvestigationStateInput,
  scope: EvidenceScope,
  reads: SourceReadLookup
): { state: InvestigationState; errors: string[] } {
  const own = canonicalizeEvidence(state.evidence, scope, reads);
  const errors = [...own.errors];
  const hypotheses = state.hypotheses.map((hypothesis) => {
    const cited = canonicalizeEvidence(hypothesis.evidence, scope, reads);
    errors.push(...cited.errors);
    return { ...hypothesis, evidence: cited.evidence };
  });
  return { state: { ...state, evidence: own.evidence, hypotheses }, errors };
}
