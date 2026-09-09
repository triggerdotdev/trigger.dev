import { describe, expect, it } from "vitest";
import { curateTrace } from "./tool-curation";
import { canonicalizeInvestigationState } from "./tool-evidence";
import type { ReadScope, ScopedReadKind } from "./tool-source-ledger";

const CONVERSATION: ReadScope = { projectRef: "proj_here", environmentId: "env_here" };
const OTHER: ReadScope = { projectRef: "P2", environmentId: "env_p2_prod" };
const THIRD: ReadScope = { projectRef: "P3", environmentId: "env_p3_prod" };

type ReadOpts = {
  runScope?: ReadScope;
  scoped?: Record<string, ReadScope[]>;
  sourceScoped?: Record<string, ReadScope[]>;
};

/** A minimal SourceReadLookup, scoped exactly like `tool-source-ledger.ts`'s real one. */
function fakeReads(opts: ReadOpts = {}) {
  const scoped = opts.scoped ?? {};
  const sourceScoped = opts.sourceScoped ?? {};
  return {
    wasReadThisTurn: (path: string, sha: string) => `${path}:${sha}` in sourceScoped,
    shaForReadPath: (path: string) => {
      const key = Object.keys(sourceScoped).find((k) => k.startsWith(`${path}:`));
      return key?.slice(path.length + 1);
    },
    scopeForRun: (_runId: string) => opts.runScope,
    scopesForScopedRead: (kind: ScopedReadKind, id: string) => scoped[`${kind}:${id}`] ?? [],
    scopesForSourceRead: (path: string, sha: string) => sourceScoped[`${path}:${sha}`] ?? [],
  };
}

function canonicalize(evidence: unknown, opts: ReadOpts = {}) {
  return canonicalizeInvestigationState(
    {
      outcome: "in_progress",
      severity: "low",
      confidence: "low",
      title: "t",
      headline: "h",
      evidence: [evidence],
      hypotheses: [],
    } as any,
    CONVERSATION,
    fakeReads(opts)
  );
}

describe("canonicalizeInvestigationState — cross-target evidence", () => {
  it.each([
    [
      "scopes a run read from a sibling target to that target, not the conversation",
      { kind: "run", uri: "run_1", label: "a run" },
      { runScope: OTHER },
      "trigger://P2/env_p2_prod/run/run_1",
    ],
    [
      "scopes a span read from a sibling target's run to that target",
      { kind: "span", runId: "run_1", spanId: "span_1", label: "a span" },
      { runScope: OTHER },
      "trigger://P2/env_p2_prod/run/run_1/span/span_1",
    ],
    [
      "scopes an error read from a sibling target to that target",
      { kind: "error", uri: "error_fp_1", label: "an error" },
      { scoped: { "error:fp_1": [OTHER] } },
      "trigger://P2/env_p2_prod/error/fp_1",
    ],
    [
      // The exact shape `get_error` attaches to its result: pasting it back is the citation.
      "accepts a ready-made full URI for an error genuinely read from that sibling target",
      { kind: "error", uri: "trigger://P2/env_p2_prod/error/fp_1", label: "an error" },
      { scoped: { "error:fp_1": [OTHER] } },
      "trigger://P2/env_p2_prod/error/fp_1",
    ],
    [
      "falls back to the conversation's own scope when nothing was read from a sibling",
      { kind: "run", uri: "run_1", label: "a run" },
      {},
      "trigger://proj_here/env_here/run/run_1",
    ],
    [
      "accepts a full URI for a run genuinely read from that sibling target",
      { kind: "run", uri: "trigger://P2/env_p2_prod/run/run_1", label: "a run" },
      { runScope: OTHER },
      "trigger://P2/env_p2_prod/run/run_1",
    ],
    [
      // Read `default` in the conversation env, then in P2/prod: reading the sibling
      // second must not relabel a same-turn citation of the conversation's own queue.
      "keeps the conversation's own queue when it was also read under a sibling target",
      { kind: "queue", uri: "trigger://proj_here/env_here/queue/default", label: "a queue" },
      { scoped: { "queue:default": [CONVERSATION, OTHER] } },
      "trigger://proj_here/env_here/queue/default",
    ],
    [
      "keeps the conversation's own queue regardless of read order",
      { kind: "queue", uri: "trigger://proj_here/env_here/queue/default", label: "a queue" },
      { scoped: { "queue:default": [OTHER, CONVERSATION] } },
      "trigger://proj_here/env_here/queue/default",
    ],
    [
      "doesn't rewrite a bare queue id read from two scopes this turn",
      { kind: "queue", uri: "default", label: "a queue" },
      { scoped: { "queue:default": [CONVERSATION, OTHER] } },
      "trigger://proj_here/env_here/queue/default",
    ],
    [
      "accepts a full URI for the sibling scope a queue was also read from",
      { kind: "queue", uri: "trigger://P2/env_p2_prod/queue/default", label: "a queue" },
      { scoped: { "queue:default": [CONVERSATION, OTHER] } },
      "trigger://P2/env_p2_prod/queue/default",
    ],
    [
      "accepts that full URI in the other read order too",
      { kind: "queue", uri: "trigger://P2/env_p2_prod/queue/default", label: "a queue" },
      { scoped: { "queue:default": [OTHER, CONVERSATION] } },
      "trigger://P2/env_p2_prod/queue/default",
    ],
    [
      "scopes a report read from a sibling target to that target, not the conversation",
      { kind: "report", uri: "health", label: "a report" },
      { scoped: { "report:health": [OTHER] } },
      "trigger://P2/env_p2_prod/report/health",
    ],
    [
      "keeps the conversation's own scope for an untargeted report read",
      { kind: "report", uri: "health", label: "a report" },
      { scoped: { "report:health": [CONVERSATION] } },
      "trigger://proj_here/env_here/report/health",
    ],
    [
      "scopes a source read from a sibling target to that target, not the conversation",
      { kind: "source", path: "src/index.ts", sha: "sha1", line: 3, label: "the code" },
      { sourceScoped: { "src/index.ts:sha1": [OTHER] } },
      "trigger://P2/env_p2_prod/source/sha1/src/index.ts?line=3",
    ],
  ])("%s", (_name, evidence, opts, uri) => {
    const { state, errors } = canonicalize(evidence, opts);
    expect(errors).toEqual([]);
    expect(state.evidence[0]!.uri).toBe(uri);
  });

  it("canonicalizes a span citation built from a curated trace's own id to the read scope", () => {
    // `curateTrace` is the only place a span id reaches the model; a citation built
    // from that id has to canonicalize to the scope the run was actually read from
    // (P2/prod), not the conversation's own.
    const trace = curateTrace({
      trace: { traceId: "trace_1", rootSpan: { id: "span_9", data: { message: "root" } } },
    });
    const spanId = trace.spans[0]!.id;
    const { state, errors } = canonicalize(
      { kind: "span", runId: "run_1", spanId, label: "a span" },
      { runScope: OTHER }
    );
    expect(errors).toEqual([]);
    expect(state.evidence[0]!.uri).toBe(`trigger://P2/env_p2_prod/run/run_1/span/span_9`);
  });

  it.each([
    [
      "rejects a full URI claiming a scope the turn never actually read from",
      { kind: "run", uri: "trigger://P2/env_p2_prod/run/run_1", label: "a run" },
      {},
      "different project or environment",
    ],
    [
      // Read `default` in P2/prod and P3/prod, never in the conversation's own env: neither
      // is the conversation's, so there's no default that isn't a guess.
      "refuses a bare id read from two siblings, never the conversation's own env",
      { kind: "queue", uri: "default", label: "a queue" },
      { scoped: { "queue:default": [OTHER, THIRD] } },
      "more than one",
    ],
    [
      "says a deployment was read from more than one scope when rejecting an unrelated URI",
      { kind: "deployment", uri: "trigger://P3/env_p3/deployment/v1", label: "a deploy" },
      { scoped: { "deployment:v1": [CONVERSATION, OTHER] } },
      "more than one",
    ],
    [
      "refuses a source read from two siblings, never the conversation's own env",
      { kind: "source", path: "src/index.ts", sha: "sha1", label: "the code" },
      { sourceScoped: { "src/index.ts:sha1": [OTHER, THIRD] } },
      "more than one",
    ],
  ])("%s", (_name, evidence, opts, message) => {
    const { state, errors } = canonicalize(evidence, opts);
    expect(state.evidence).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(message);
  });
});
