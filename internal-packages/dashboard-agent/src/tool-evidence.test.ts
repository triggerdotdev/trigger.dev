import { describe, expect, it } from "vitest";
import { canonicalizeEvidence, type EvidenceScope } from "./tool-evidence";
import type { SourceReadLookup } from "./tool-source-ledger";

const scope: EvidenceScope = { projectRef: "proj_1", environmentId: "env_1" };

function fakeReads(overrides?: Partial<SourceReadLookup>): SourceReadLookup {
  return {
    wasReadThisTurn: () => false,
    shaForReadPath: () => undefined,
    wasSpanReadThisTurn: () => false,
    dirtyForSha: () => false,
    ...overrides,
  };
}

describe("span evidence is validated against this turn's trace reads", () => {
  it("accepts a span id this turn's trace read returned", () => {
    const reads = fakeReads({
      wasSpanReadThisTurn: (runId, spanId) => runId === "run_1" && spanId === "span_abc",
    });
    const { evidence, errors } = canonicalizeEvidence(
      [{ kind: "span", runId: "run_1", spanId: "span_abc", label: "failed span" }],
      scope,
      reads
    );
    expect(errors).toEqual([]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.uri).toContain("run_1");
    expect(evidence[0]!.uri).toContain("span_abc");
  });

  it("rejects a span id no trace read returned this turn", () => {
    const reads = fakeReads(); // nothing recorded
    const { evidence, errors } = canonicalizeEvidence(
      [{ kind: "span", runId: "run_1", spanId: "span_invented", label: "a made-up span" }],
      scope,
      reads
    );
    expect(evidence).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("span_invented");
    expect(errors[0]).toContain("get_run_trace");
  });

  it("rejects a span id read for a different run", () => {
    const reads = fakeReads({
      wasSpanReadThisTurn: (runId, spanId) => runId === "run_other" && spanId === "span_abc",
    });
    const { evidence, errors } = canonicalizeEvidence(
      [{ kind: "span", runId: "run_1", spanId: "span_abc", label: "wrong run" }],
      scope,
      reads
    );
    expect(evidence).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe("source evidence is stamped dirty from the read commit's snapshot", () => {
  it("carries dirty:true when the read commit's snapshot was dirty", () => {
    const reads = fakeReads({
      wasReadThisTurn: () => true,
      dirtyForSha: (sha) => sha === "deadbeef",
    });
    const { evidence, errors } = canonicalizeEvidence(
      [{ kind: "source", path: "src/x.ts", sha: "deadbeef", label: "the fix" }],
      scope,
      reads
    );
    expect(errors).toEqual([]);
    expect(evidence[0]).toMatchObject({ dirty: true });
  });

  it("omits dirty when the read commit's snapshot was clean", () => {
    const reads = fakeReads({
      wasReadThisTurn: () => true,
      dirtyForSha: () => false,
    });
    const { evidence, errors } = canonicalizeEvidence(
      [{ kind: "source", path: "src/x.ts", sha: "clean123", label: "the fix" }],
      scope,
      reads
    );
    expect(errors).toEqual([]);
    expect(evidence[0]).not.toHaveProperty("dirty");
  });
});
