import { SubscribeRunRawShape } from "@trigger.dev/core/v3/schemas";
import { describe, expect, it } from "vitest";
import {
  buildElectricSchemaHeader,
  buildRowsBody,
  buildSnapshotBody,
  buildUpdateBody,
  buildUpToDateBody,
  encodeOffset,
  parseOffsetUpdatedAtMs,
  type RealtimeRunRow,
  rewriteBodyForLegacyApiVersion,
  serializeRunRow,
} from "~/services/realtime/electricStreamProtocol.server";

function sampleRow(overrides: Partial<RealtimeRunRow> = {}): RealtimeRunRow {
  return {
    id: "run_abc123",
    taskIdentifier: "my-task",
    createdAt: new Date("2026-06-06T10:00:00.000Z"),
    updatedAt: new Date("2026-06-06T10:05:30.123Z"),
    startedAt: new Date("2026-06-06T10:01:00.000Z"),
    delayUntil: null,
    queuedAt: new Date("2026-06-06T10:00:30.000Z"),
    expiredAt: null,
    completedAt: null,
    friendlyId: "run_friendly_abc",
    number: 42,
    isTest: true,
    status: "EXECUTING",
    usageDurationMs: 1234,
    costInCents: 0.55,
    baseCostInCents: 0.25,
    ttl: "1h",
    payload: '{"hello":"world"}',
    payloadType: "application/json",
    metadata: '{"step":1}',
    metadataType: "application/json",
    output: null,
    outputType: "application/json",
    runTags: ["user:123", "env:prod"],
    error: null,
    realtimeStreams: [],
    ...overrides,
  };
}

/**
 * Faithful re-implementation of the @electric-sql/client value parser rules
 * (defaultParser + pgArrayParser), so we can decode our wire `value` object the
 * same way the deployed client would, then validate against the real SDK schema.
 * Source: @electric-sql/client@1.0.14 src/parser.ts.
 */
function electricParse(
  value: Record<string, string | null>,
  schema: Record<string, { type: string; dims?: number }>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null) {
      out[key] = null;
      continue;
    }
    const info = schema[key];
    if (!info) {
      out[key] = raw;
      continue;
    }
    if (info.dims && info.dims > 0) {
      out[key] = parsePgTextArray(raw);
      continue;
    }
    switch (info.type) {
      case "bool":
        out[key] = raw === "t" || raw === "true";
        break;
      case "int8":
        out[key] = BigInt(raw);
        break;
      case "int2":
      case "int4":
      case "float4":
      case "float8":
        out[key] = Number(raw);
        break;
      case "json":
      case "jsonb":
        out[key] = JSON.parse(raw);
        break;
      default:
        out[key] = raw; // text/timestamp pass through as strings
    }
  }
  return out;
}

function parsePgTextArray(literal: string): string[] {
  if (literal === "{}") {
    return [];
  }
  const inner = literal.slice(1, -1);
  const result: string[] = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === '"') {
      i++;
      let s = "";
      while (i < inner.length && inner[i] !== '"') {
        if (inner[i] === "\\") {
          i++;
        }
        s += inner[i];
        i++;
      }
      result.push(s);
      i++; // closing quote
      if (inner[i] === ",") i++;
    } else {
      let s = "";
      while (i < inner.length && inner[i] !== ",") {
        s += inner[i];
        i++;
      }
      result.push(s);
      if (inner[i] === ",") i++;
    }
  }
  return result;
}

describe("electricStreamProtocol serializer", () => {
  it("encodes each Postgres type the way the Electric client expects", () => {
    const value = serializeRunRow(sampleRow());

    // text: passed through as-is
    expect(value.id).toBe("run_abc123");
    expect(value.status).toBe("EXECUTING");
    expect(value.payload).toBe('{"hello":"world"}');

    // int/float: stringified
    expect(value.number).toBe("42");
    expect(value.usageDurationMs).toBe("1234");
    expect(value.costInCents).toBe("0.55");

    // bool: postgres "t"/"f"
    expect(value.isTest).toBe("t");

    // timestamp: ISO without trailing Z (the SDK appends Z before parsing)
    expect(value.updatedAt).toBe("2026-06-06T10:05:30.123");
    expect(value.createdAt).toBe("2026-06-06T10:00:00.000");

    // nullable timestamp: null stays null
    expect(value.delayUntil).toBeNull();
    expect(value.completedAt).toBeNull();

    // text[]: quoted pg array literal; empty realtimeStreams (@default([])) => {}
    expect(value.runTags).toBe('{"user:123","env:prod"}');
    expect(value.realtimeStreams).toBe("{}");

    // jsonb: null stays null
    expect(value.error).toBeNull();
  });

  it("encodes an empty no-default array column (runTags) as null, matching Electric", () => {
    // runTags has no Postgres default, so an empty value is stored as SQL NULL and
    // Electric emits `null` (not `{}`). realtimeStreams has @default([]), so its
    // empty value is `{}`. Prisma hands us `[]` for both; we re-derive the wire form.
    const value = serializeRunRow(sampleRow({ runTags: [], realtimeStreams: [] }));
    expect(value.runTags).toBeNull();
    expect(value.realtimeStreams).toBe("{}");
  });

  it("encodes jsonb error as a JSON string", () => {
    const value = serializeRunRow(sampleRow({ error: { type: "STRING_ERROR", raw: "boom" } }));
    expect(value.error).toBe('{"type":"STRING_ERROR","raw":"boom"}');
  });

  it("round-trips through the client parser into a valid SubscribeRunRawShape", () => {
    const row = sampleRow({ error: { type: "STRING_ERROR", raw: "boom" } });
    const value = serializeRunRow(row);
    const schema = JSON.parse(buildElectricSchemaHeader());

    const decoded = electricParse(value, schema);
    const parsed = SubscribeRunRawShape.parse(decoded);

    expect(parsed.id).toBe("run_abc123");
    expect(parsed.friendlyId).toBe("run_friendly_abc");
    expect(parsed.status).toBe("EXECUTING");
    expect(parsed.number).toBe(42);
    expect(parsed.isTest).toBe(true);
    expect(parsed.usageDurationMs).toBe(1234);
    expect(parsed.costInCents).toBeCloseTo(0.55);
    expect(parsed.runTags).toEqual(["user:123", "env:prod"]);
    expect(parsed.realtimeStreams).toEqual([]);
    // RawShapeDate appends "Z" and coerces to a Date equal to the source instant.
    expect(parsed.createdAt.toISOString()).toBe("2026-06-06T10:00:00.000Z");
    expect(parsed.updatedAt.toISOString()).toBe("2026-06-06T10:05:30.123Z");
    expect(parsed.startedAt?.toISOString()).toBe("2026-06-06T10:01:00.000Z");
    expect(parsed.delayUntil ?? null).toBeNull();
    expect(parsed.error).toEqual({ type: "STRING_ERROR", raw: "boom" });
  });

  it("honors skipColumns (but never the reserved columns)", () => {
    const value = serializeRunRow(sampleRow(), ["payload", "output", "id", "status"]);
    expect(value.payload).toBeUndefined();
    expect(value.output).toBeUndefined();
    // reserved columns can't be skipped
    expect(value.id).toBe("run_abc123");
    expect(value.status).toBe("EXECUTING");

    const schema = JSON.parse(buildElectricSchemaHeader(["payload"]));
    expect(schema.payload).toBeUndefined();
    expect(schema.status).toBeDefined();
  });
});

describe("electricStreamProtocol message bodies", () => {
  it("emits insert + up-to-date for an initial snapshot", () => {
    const messages = JSON.parse(buildSnapshotBody(sampleRow()));
    expect(messages).toHaveLength(2);
    expect(messages[0].headers.operation).toBe("insert");
    expect(messages[0].key).toBe('"public"."TaskRun"/"run_abc123"');
    expect(messages[0].value.status).toBe("EXECUTING");
    expect(messages[1].headers.control).toBe("up-to-date");
  });

  it("emits a bare up-to-date for an empty (missing) run snapshot", () => {
    const messages = JSON.parse(buildSnapshotBody(null));
    expect(messages).toHaveLength(1);
    expect(messages[0].headers.control).toBe("up-to-date");
  });

  it("emits update + up-to-date for a live change", () => {
    const messages = JSON.parse(buildUpdateBody(sampleRow()));
    expect(messages[0].headers.operation).toBe("update");
    expect(messages[1].headers.control).toBe("up-to-date");
  });

  it("emits a bare up-to-date when nothing advanced", () => {
    const messages = JSON.parse(buildUpToDateBody());
    expect(messages).toEqual([{ headers: { control: "up-to-date" } }]);
  });

  it("uses the same merge key across insert and update so the client merges by row", () => {
    const insert = JSON.parse(buildSnapshotBody(sampleRow()))[0];
    const update = JSON.parse(buildUpdateBody(sampleRow()))[0];
    expect(insert.key).toBe(update.key);
  });
});

describe("electricStreamProtocol multi-row (tag-list) bodies", () => {
  it("emits one change message per row with per-row operation, then up-to-date", () => {
    const a = sampleRow({ id: "run_a" });
    const b = sampleRow({ id: "run_b", status: "QUEUED" });
    const messages = JSON.parse(
      buildRowsBody([
        { row: a, operation: "insert" },
        { row: b, operation: "update" },
      ])
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].headers.operation).toBe("insert");
    expect(messages[0].key).toBe('"public"."TaskRun"/"run_a"');
    expect(messages[1].headers.operation).toBe("update");
    expect(messages[1].key).toBe('"public"."TaskRun"/"run_b"');
    expect(messages[1].value.status).toBe("QUEUED");
    expect(messages[2].headers.control).toBe("up-to-date");
  });

  it("emits a bare up-to-date for an empty change set", () => {
    const messages = JSON.parse(buildRowsBody([]));
    expect(messages).toEqual([{ headers: { control: "up-to-date" } }]);
  });

  it("honors skipColumns across all rows", () => {
    const messages = JSON.parse(
      buildRowsBody([{ row: sampleRow(), operation: "insert" }], ["payload"])
    );
    expect(messages[0].value.payload).toBeUndefined();
    expect(messages[0].value.status).toBe("EXECUTING");
  });
});

describe("electricStreamProtocol tokens + legacy rewrite", () => {
  it("encodes and parses the offset updatedAt segment", () => {
    const offset = encodeOffset(1717667130123, 7);
    expect(offset).toBe("1717667130123_7");
    expect(parseOffsetUpdatedAtMs(offset)).toBe(1717667130123);
  });

  it("treats the initial offset (-1) and garbage as zero", () => {
    expect(parseOffsetUpdatedAtMs("-1")).toBe(0);
    expect(parseOffsetUpdatedAtMs(null)).toBe(0);
    expect(parseOffsetUpdatedAtMs("nonsense")).toBe(0);
  });

  it("rewrites DEQUEUED to EXECUTING for legacy API versions", () => {
    const body = buildUpdateBody(sampleRow({ status: "DEQUEUED" }));
    expect(body).toContain('"status":"DEQUEUED"');
    const rewritten = rewriteBodyForLegacyApiVersion(body);
    expect(rewritten).not.toContain('"status":"DEQUEUED"');
    expect(rewritten).toContain('"status":"EXECUTING"');
  });
});
