import { describe, expect, it } from "vitest";
import { decodeLogsSearchCursor, encodeLogsSearchCursor } from "./logSearchCursor.server";
import {
  clickhouseTimestampCeilMs,
  continueLogsSearchSlice,
  initialLogsSearchSlice,
  logsSearchRangeFrom,
  logsSearchRangeTo,
  rebaseLogsSearchSliceToRange,
  nextLogsSearchSlice,
  retryTimedOutLogsSearchSlice,
  type LogsSearchKeyset,
  type LogsSearchSlice,
} from "./logSearchSlices";

type TestRow = LogsSearchKeyset & { timeNs: bigint; id: string };

const RANGE_FROM = Date.parse("2026-08-14T00:00:00.000Z");
const RANGE_TO = Date.parse("2026-08-15T00:00:00.000Z");

function timestamp(timeNs: bigint): string {
  const milliseconds = Number(timeNs / 1_000_000n);
  const nanoseconds = (timeNs % 1_000_000_000n).toString().padStart(9, "0");
  return `${new Date(milliseconds).toISOString().slice(0, 19).replace("T", " ")}.${nanoseconds}`;
}

function compareRowsDescending(a: LogsSearchKeyset, b: LogsSearchKeyset): number {
  if (a.triggeredTimestamp !== b.triggeredTimestamp) {
    return b.triggeredTimestamp.localeCompare(a.triggeredTimestamp);
  }
  if (a.traceId !== b.traceId) return b.traceId.localeCompare(a.traceId);
  if (a.spanId !== b.spanId) return b.spanId.localeCompare(a.spanId);
  const aFingerprint = BigInt(a.projectionFingerprint);
  const bFingerprint = BigInt(b.projectionFingerprint);
  return aFingerprint === bFingerprint ? 0 : aFingerprint < bFingerprint ? 1 : -1;
}

function querySlice(rows: TestRow[], slice: LogsSearchSlice, limit: number): TestRow[] {
  const fromNs = BigInt(Math.ceil(slice.sliceFrom)) * 1_000_000n;
  const toNs = BigInt(Math.floor(slice.sliceTo)) * 1_000_000n;

  return rows
    .filter(
      (row) =>
        row.timeNs >= fromNs && (slice.upperInclusive ? row.timeNs <= toNs : row.timeNs < toNs)
    )
    .filter((row) => !slice.keyset || compareRowsDescending(row, slice.keyset) > 0)
    .sort(compareRowsDescending)
    .slice(0, limit + 1);
}

function createRows(seed: number): TestRow[] {
  const rows: TestRow[] = [];
  let state = seed;
  const random = () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };

  for (let index = 0; index < 120; index++) {
    const millisecond = RANGE_FROM + Math.floor(random() * (RANGE_TO - RANGE_FROM));
    const nanosWithinMillisecond =
      index % 5 === 0 ? BigInt(index % 1_000) : BigInt(Math.floor(random() * 1_000_000));
    const timeNs = BigInt(millisecond) * 1_000_000n + nanosWithinMillisecond;
    rows.push({
      id: `${seed}-${index}`,
      timeNs,
      triggeredTimestamp: timestamp(timeNs),
      traceId: `trace_${index % 7}`,
      spanId: `span_${index % 11}`,
      projectionFingerprint: String(index),
    });
  }

  const tiedMillisecond = BigInt(RANGE_TO - 30 * 60 * 1000) * 1_000_000n;
  for (let index = 1; index <= 8; index++) {
    const timeNs = tiedMillisecond + BigInt(index * 101);
    rows.push({
      id: `${seed}-tie-${index}`,
      timeNs,
      triggeredTimestamp: timestamp(timeNs),
      traceId: `trace_tie_${index % 2}`,
      spanId: `span_tie_${index}`,
      projectionFingerprint: String(index),
    });
  }

  const exactTieNs = tiedMillisecond + 999n;
  for (const fingerprint of ["2", "10", "100"]) {
    rows.push({
      id: `${seed}-exact-tie-${fingerprint}`,
      timeNs: exactTieNs,
      triggeredTimestamp: timestamp(exactTieNs),
      traceId: "trace_exact_tie",
      spanId: "span_exact_tie",
      projectionFingerprint: fingerprint,
    });
  }

  return rows;
}

function roundTripCursor(slice: LogsSearchSlice): LogsSearchSlice {
  const encoded = encodeLogsSearchCursor("org", "env", "filters", slice);
  const decoded = decodeLogsSearchCursor(encoded);
  expect(decoded).not.toBeNull();
  return decoded!.slice;
}

describe("adaptive log search slices", () => {
  it("restarts cursors from older slice formats", () => {
    const oldCursor = Buffer.from(JSON.stringify({ v: 5 })).toString("base64");
    expect(decodeLogsSearchCursor(oldCursor)).toBeNull();
  });

  it("rejects v6 keysets without the projection fingerprint", () => {
    const slice = initialLogsSearchSlice(new Date(RANGE_FROM), new Date(RANGE_TO));
    const cursor = Buffer.from(
      JSON.stringify({
        v: 6,
        organizationId: "org",
        environmentId: "env",
        filterFingerprint: "filters",
        slice: {
          ...slice,
          keyset: {
            triggeredTimestamp: "2026-08-14 23:30:00.000000000",
            traceId: "trace",
            spanId: "span",
          },
        },
      })
    ).toString("base64");

    expect(decodeLogsSearchCursor(cursor)).toBeNull();
  });

  it("rounds DateTime64(9) keysets up only for coarse sizing", () => {
    expect(clickhouseTimestampCeilMs("2026-08-14 12:00:00.123000000")).toBe(
      Date.parse("2026-08-14T12:00:00.123Z")
    );
    expect(clickhouseTimestampCeilMs("2026-08-14 12:00:00.123000001")).toBe(
      Date.parse("2026-08-14T12:00:00.124Z")
    );
  });

  it("rederives relative ranges from the frozen anchor and hard clamps the floor", () => {
    expect(logsSearchRangeFrom(RANGE_TO, { periodMs: 60 * 60 * 1000 })).toBe(
      RANGE_TO - 60 * 60 * 1000
    );
    expect(
      logsSearchRangeFrom(RANGE_TO, {
        periodMs: 24 * 60 * 60 * 1000,
        retentionFloor: RANGE_TO - 60 * 60 * 1000,
      })
    ).toBe(RANGE_TO - 60 * 60 * 1000);
    expect(
      logsSearchRangeFrom(RANGE_TO, {
        periodMs: 24 * 60 * 60 * 1000,
        explicitFrom: RANGE_TO - 30 * 60 * 1000,
      })
    ).toBe(RANGE_TO - 30 * 60 * 1000);
    expect(
      logsSearchRangeFrom(RANGE_TO, {
        periodMs: 24 * 60 * 60 * 1000,
        explicitFrom: RANGE_TO + 1,
      })
    ).toBe(RANGE_TO + 1);
  });

  it("keeps before-only ranges relative to the request anchor", () => {
    const explicitTo = RANGE_TO - 30 * 60 * 1000;
    const rangeFrom = logsSearchRangeFrom(RANGE_TO, { periodMs: 60 * 60 * 1000 });
    const rangeTo = logsSearchRangeTo(RANGE_TO, explicitTo);
    const slice = initialLogsSearchSlice(new Date(rangeFrom), new Date(rangeTo), RANGE_TO);

    expect(rangeFrom).toBe(RANGE_TO - 60 * 60 * 1000);
    expect(slice).toMatchObject({
      anchorTime: RANGE_TO,
      sliceFrom: rangeFrom,
      sliceTo: explicitTo,
    });
  });

  it("truncates fractional relative floors to integer milliseconds", () => {
    expect(logsSearchRangeFrom(RANGE_TO, { periodMs: 60 * 60 * 1000 + 0.5 })).toBe(
      Math.trunc(RANGE_TO - (60 * 60 * 1000 + 0.5))
    );
  });

  it("rebases a valid cursor when the retention cutoff moves", () => {
    const slice = initialLogsSearchSlice(new Date(RANGE_FROM), new Date(RANGE_TO));
    const next = nextLogsSearchSlice(slice, RANGE_FROM, { readRows: 0, elapsedMs: 1_000 });
    expect(next).toBeDefined();

    const movedFloor = RANGE_FROM + 2_000;
    expect(rebaseLogsSearchSliceToRange(next!, movedFloor, RANGE_TO, RANGE_TO)).toEqual({
      ...next,
      sliceFrom: movedFloor,
    });
  });

  it("rejects cursor slices outside the current upper bound", () => {
    const slice = initialLogsSearchSlice(new Date(RANGE_FROM), new Date(RANGE_TO));

    expect(rebaseLogsSearchSliceToRange(slice, RANGE_FROM, RANGE_TO, RANGE_TO)).toEqual(slice);
    expect(rebaseLogsSearchSliceToRange(slice, RANGE_FROM, RANGE_TO - 1, RANGE_TO)).toBeUndefined();
    expect(rebaseLogsSearchSliceToRange(slice, RANGE_FROM, RANGE_TO, RANGE_TO - 1)).toBeUndefined();
  });

  it("expires zero-width cursors that are wholly below retention", () => {
    const expiredTo = RANGE_FROM - 50 * 24 * 60 * 60 * 1000;
    const expired: LogsSearchSlice = {
      anchorTime: expiredTo,
      sliceFrom: expiredTo,
      sliceTo: expiredTo,
      remainingUpper: expiredTo,
      upperInclusive: true,
      sliceIndex: 0,
    };

    expect(
      rebaseLogsSearchSliceToRange(
        roundTripCursor(expired),
        RANGE_FROM - 7 * 24 * 60 * 60 * 1000,
        expiredTo,
        RANGE_TO
      )
    ).toBe("expired");
  });

  it("does not learn density from a limit-filled partial slice", () => {
    const slice = initialLogsSearchSlice(new Date(RANGE_FROM), new Date(RANGE_TO));
    const partial = continueLogsSearchSlice(slice, {
      triggeredTimestamp: "2026-08-14 23:30:00.000000001",
      traceId: "trace",
      spanId: "span",
      projectionFingerprint: "1",
    });

    expect(partial.rowsPerHour).toBeUndefined();
    expect(
      nextLogsSearchSlice(slice, RANGE_FROM, { readRows: 10_000, elapsedMs: 2_500 })
    ).toHaveProperty("rowsPerHour", 10_000);
  });

  it("stops retrying after a minimum-size slice times out", () => {
    const rangeTo = RANGE_FROM + 5 * 60 * 1000;
    const slice = initialLogsSearchSlice(new Date(RANGE_FROM), new Date(rangeTo));

    expect(retryTimedOutLogsSearchSlice(slice)).toBeUndefined();
  });

  it("returns every row exactly once across varied pages, slices, and timeouts", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rows = createRows(seed);
      const returned: string[] = [];
      const timedOutAttempts = new Set<string>();
      let slice: LogsSearchSlice | undefined = roundTripCursor(
        initialLogsSearchSlice(new Date(RANGE_FROM), new Date(RANGE_TO))
      );
      let request = 0;

      while (slice) {
        request++;
        expect(request).toBeLessThan(2_000);

        const attempt = `${slice.sliceIndex}:${slice.sliceFrom}:${slice.remainingUpper}:${slice.keyset?.triggeredTimestamp ?? "start"}`;
        const shouldTimeout = (request + seed) % 4 === 0 && !timedOutAttempts.has(attempt);
        if (shouldTimeout) {
          timedOutAttempts.add(attempt);
          const retry = retryTimedOutLogsSearchSlice(slice);
          if (retry) {
            slice = roundTripCursor(retry);
            continue;
          }

          // A minimum-size timeout is terminal for automatic search. An explicit retry keeps the
          // same slice, so the failed interval is neither skipped nor falsely completed.
          slice = roundTripCursor(slice);
          continue;
        }

        const limit = 1 + ((seed * 13 + request * 7) % 17);
        const result = querySlice(rows, slice, limit);
        const page = result.slice(0, limit);
        returned.push(...page.map((row) => row.id));

        const stats = {
          readRows: 100 + ((seed * 997 + request * 101) % 100_000),
          elapsedMs: 1_200 + ((seed * 211 + request * 307) % 4_000),
        };
        if (result.length > limit) {
          const last = page[page.length - 1]!;
          slice = roundTripCursor(
            continueLogsSearchSlice(slice, {
              triggeredTimestamp: last.triggeredTimestamp,
              traceId: last.traceId,
              spanId: last.spanId,
              projectionFingerprint: last.projectionFingerprint,
            })
          );
        } else {
          const next = nextLogsSearchSlice(slice, RANGE_FROM, stats);
          slice = next ? roundTripCursor(next) : undefined;
        }
      }

      expect(returned.sort()).toEqual(rows.map((row) => row.id).sort());
      expect(new Set(returned).size).toBe(rows.length);
    }
  });
});
