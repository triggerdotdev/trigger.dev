import {
  formatTriggerUri,
  safeParseTriggerUri,
  type Evidence,
  type EvidenceRef,
  type InvestigationState,
  type InvestigationStateInput,
  type ParsedTriggerUri,
} from "@internal/dashboard-agent-contracts";
import { bareFingerprint } from "./tool-read-scope";
import type { ReadScope, ScopedReadKind, SourceReadLookup } from "./tool-source-ledger";

/** The kind+id a parsed URI's identity keys scoped reads off of, or none. */
function scopedIdentity(
  parsed: ParsedTriggerUri
): { kind: ScopedReadKind; id: string } | undefined {
  switch (parsed.kind) {
    case "error":
      return { kind: "error", id: bareFingerprint(parsed.fingerprint) };
    case "queue":
      return { kind: "queue", id: parsed.name };
    case "deployment":
      return { kind: "deployment", id: parsed.version };
    case "report":
      return { kind: "report", id: parsed.key };
    default:
      return undefined;
  }
}

/** The inverse of `scopedIdentity`'s kind+id mapping: builds the parsed URI for a scoped kind. */
function scopedParsedUri(kind: ScopedReadKind, scope: ReadScope, id: string): ParsedTriggerUri {
  switch (kind) {
    case "error":
      return { ...scope, kind: "error", fingerprint: id };
    case "queue":
      return { ...scope, kind: "queue", name: id };
    case "deployment":
      return { ...scope, kind: "deployment", version: id };
    case "report":
      return { ...scope, kind: "report", key: id };
  }
}

// A name isn't globally unique, so this checks membership across every scope read this turn.
function scopeIsAcceptable(
  parsed: ParsedTriggerUri,
  reads: SourceReadLookup,
  base: ReadScope
): boolean {
  if (parsed.projectRef === base.projectRef && parsed.environmentId === base.environmentId) {
    return true;
  }
  if (parsed.kind === "run" || parsed.kind === "span") {
    const scope = reads.scopeForRun(parsed.runId);
    return (
      !!scope &&
      scope.projectRef === parsed.projectRef &&
      scope.environmentId === parsed.environmentId
    );
  }
  const identity = scopedIdentity(parsed);
  if (!identity) return false;
  return reads
    .scopesForScopedRead(identity.kind, identity.id)
    .some((s) => s.projectRef === parsed.projectRef && s.environmentId === parsed.environmentId);
}

// Two or more scopes with none matching the conversation's own: no default isn't a guess.
function preferFromScopes(
  scopes: ReadScope[],
  base: ReadScope
): { ok: true; scope: ReadScope } | { ok: false } {
  if (scopes.length === 0) return { ok: true, scope: base };
  if (scopes.length === 1) return { ok: true, scope: scopes[0]! };
  const matchesBase = scopes.some(
    (s) => s.projectRef === base.projectRef && s.environmentId === base.environmentId
  );
  return matchesBase ? { ok: true, scope: base } : { ok: false };
}

// Exposes `preferFromScopes`'s rule to callers outside evidence canonicalization.
export function resolvedScopeFor(
  kind: "run" | ScopedReadKind,
  id: string,
  reads: SourceReadLookup,
  base: ReadScope
): { ok: true; scope: ReadScope } | { ok: false } {
  if (kind === "run") return { ok: true, scope: reads.scopeForRun(id) ?? base };
  return preferFromScopes(reads.scopesForScopedRead(kind, id), base);
}

/**
 * Builds the canonical `trigger://` URI for a cited ref. A ref that can't be
 * canonicalized is returned as a named error, never dropped.
 */
function canonicalizeEvidence(
  items: EvidenceRef[],
  scope: ReadScope,
  reads: SourceReadLookup
): { evidence: Evidence[]; errors: string[] } {
  const evidence: Evidence[] = [];
  const errors: string[] = [];
  const base = { projectRef: scope.projectRef, environmentId: scope.environmentId };

  for (const item of items) {
    if (item.kind === "span") {
      const runId = item.runId.trim();
      evidence.push({
        kind: "span",
        label: item.label,
        ...(item.excerpt === undefined ? {} : { excerpt: item.excerpt }),
        uri: formatTriggerUri({
          ...(reads.scopeForRun(runId) ?? base),
          kind: "span",
          runId,
          spanId: item.spanId.trim(),
        }),
      });
      continue;
    }

    if (item.kind === "source") {
      const path = item.path.trim().replace(/^\/+/, "");
      // From this turn's read ledger and nowhere else: a snapshot sha isn't proof of reading.
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
      const preferred = preferFromScopes(reads.scopesForSourceRead(path, sha), base);
      if (!preferred.ok) {
        errors.push(
          `source "${path}" was read from more than one environment this turn — cite the one you mean`
        );
        continue;
      }
      evidence.push({
        kind: "source",
        label: item.label,
        ...(item.excerpt === undefined ? {} : { excerpt: item.excerpt }),
        uri: formatTriggerUri({
          ...preferred.scope,
          kind: "source",
          sha,
          path,
          ...(item.line === undefined ? {} : { line: item.line }),
        }),
      });
      continue;
    }

    let ref = item.uri.trim();

    // Already a full URI: kind and scope both have to match — no smuggling in another scope.
    const asUri = safeParseTriggerUri(ref);
    if (asUri.success) {
      const parsedUri = asUri.data;
      if (parsedUri.kind !== item.kind) {
        errors.push(`${item.kind} evidence cites a ${parsedUri.kind} URI (${ref})`);
        continue;
      }
      if (!scopeIsAcceptable(parsedUri, reads, base)) {
        const identity = scopedIdentity(parsedUri);
        const ambiguous = identity
          ? reads.scopesForScopedRead(identity.kind, identity.id).length > 1
          : false;
        errors.push(
          `${ref} belongs to a different project or environment` +
            (ambiguous ? " (it was read from more than one this turn — cite the one you mean)" : "")
        );
        continue;
      }
      const normalizedUri =
        parsedUri.kind === "error"
          ? { ...parsedUri, fingerprint: bareFingerprint(parsedUri.fingerprint) }
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
        parsed = { ...(reads.scopeForRun(ref) ?? base), kind: "run", runId: ref };
        break;
      case "error":
      case "queue":
      case "deployment":
      case "report": {
        const kind = item.kind;
        const id = kind === "error" ? bareFingerprint(ref) : ref;
        const preferred = preferFromScopes(reads.scopesForScopedRead(kind, id), base);
        if (!preferred.ok) {
          errors.push(
            `${kind} ${ref} was read from more than one environment this turn — cite the one you mean`
          );
          continue;
        }
        parsed = scopedParsedUri(kind, preferred.scope, id);
        break;
      }
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
  scope: ReadScope,
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
