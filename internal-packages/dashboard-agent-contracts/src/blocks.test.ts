import { describe, expect, it } from "vitest";
import {
  VIEW_BLOCK_VERSION,
  isRevisableBlock,
  legacyViewBlockSchema,
  parseStoredViewBlock,
  viewBlockInputSchema,
  viewBlockSchema,
  type EnvelopedViewBlock,
  type ViewBlock,
} from "./blocks.js";

// A diagnosis block exactly as stored before the envelope existed.
const legacyDiagnosis = {
  type: "diagnosis",
  runId: "run_abc123",
  summary: "The task threw a TypeError while reading the order payload.",
  category: "user_code_error",
  likelyCause: "`order.items` is undefined for orders created before the v2 migration.",
  confidence: "high",
  evidence: [
    { type: "error", detail: "TypeError: Cannot read properties of undefined (reading 'items')" },
    {
      type: "source",
      detail: "processOrder.ts sums order.items",
      reference: "src/processOrder.ts:42",
    },
  ],
  impact: "12 runs hit the same error in the last hour.",
  nextSteps: ["Guard against a missing items array", "Backfill the legacy orders"],
  actions: [{ label: "View run", kind: "view_run", target: "run_abc123" }],
};

// A chart block exactly as stored before the envelope existed.
const legacyChart = {
  type: "chart",
  title: "Failures per hour",
  query:
    "SELECT toStartOfHour(created_at) AS bucket, countIf(status = 'FAILED') AS failures FROM runs",
  period: "24h",
  chartType: "line",
  xAxisColumn: "bucket",
  yAxisColumns: ["failures"],
  groupByColumn: null,
  stacked: false,
  aggregation: "sum",
};

const envelope = { id: "toolcall_1", revision: 0, version: VIEW_BLOCK_VERSION };

describe("legacy (stored) parsing", () => {
  it("parses a pre-envelope diagnosis block", () => {
    const parsed = parseStoredViewBlock(legacyDiagnosis);
    expect(parsed.type).toBe("diagnosis");
    expect(parsed.id).toBeUndefined();
    expect(parsed.revision).toBeUndefined();
    expect(parsed.version).toBeUndefined();
  });

  it("parses a pre-envelope chart block", () => {
    expect(legacyViewBlockSchema.safeParse(legacyChart).success).toBe(true);
  });

  it("parses an enveloped block too", () => {
    const parsed = parseStoredViewBlock({ ...legacyDiagnosis, ...envelope });
    expect(parsed.id).toBe("toolcall_1");
    expect(parsed.revision).toBe(0);
  });

  it("still rejects a block that is not in the catalog", () => {
    expect(legacyViewBlockSchema.safeParse({ type: "table", rows: [] }).success).toBe(false);
  });

  it("still rejects a catalog block with a broken payload", () => {
    expect(
      legacyViewBlockSchema.safeParse({ ...legacyDiagnosis, confidence: "very-high" }).success
    ).toBe(false);
    expect(legacyViewBlockSchema.safeParse({ ...legacyChart, yAxisColumns: [] }).success).toBe(
      false
    );
  });
});

describe("strict (emit) parsing", () => {
  it("requires the envelope", () => {
    expect(viewBlockSchema.safeParse(legacyDiagnosis).success).toBe(false);
    expect(viewBlockSchema.safeParse({ ...legacyDiagnosis, ...envelope }).success).toBe(true);
    expect(viewBlockSchema.safeParse({ ...legacyChart, ...envelope }).success).toBe(true);
  });

  it("rejects a negative revision or a zero version", () => {
    expect(viewBlockSchema.safeParse({ ...legacyChart, ...envelope, revision: -1 }).success).toBe(
      false
    );
    expect(viewBlockSchema.safeParse({ ...legacyChart, ...envelope, version: 0 }).success).toBe(
      false
    );
  });

  it("produces values assignable to the lenient renderer type", () => {
    const strict: EnvelopedViewBlock = viewBlockSchema.parse({ ...legacyDiagnosis, ...envelope });
    const lenient: ViewBlock = strict;
    expect(lenient.id).toBe("toolcall_1");
  });
});

describe("model-facing input schema", () => {
  it("accepts a body with no envelope", () => {
    expect(viewBlockInputSchema.safeParse(legacyDiagnosis).success).toBe(true);
  });

  it("strips an envelope the model tried to supply", () => {
    const parsed = viewBlockInputSchema.parse({ ...legacyChart, ...envelope });
    expect(parsed).not.toHaveProperty("id");
    expect(parsed).not.toHaveProperty("revision");
  });
});

describe("isRevisableBlock", () => {
  it("is false without an id", () => {
    expect(isRevisableBlock(parseStoredViewBlock(legacyDiagnosis))).toBe(false);
  });

  it("is true with an id", () => {
    expect(isRevisableBlock(parseStoredViewBlock({ ...legacyChart, ...envelope }))).toBe(true);
  });
});
