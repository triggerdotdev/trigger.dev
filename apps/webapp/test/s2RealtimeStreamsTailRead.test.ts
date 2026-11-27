import { describe, expect, it } from "vitest";
import { classifyTailRead, parseTailSeq } from "~/services/realtime/s2realtimeStreams.server";

const record = { seq_num: 7, timestamp: 1, body: "" };

describe("classifyTailRead", () => {
  it("returns the records of a 200", () => {
    expect(classifyTailRead(200, JSON.stringify({ records: [record] }))).toEqual({
      kind: "records",
      records: [record],
    });
  });

  // Catches: a 200 with no records (s2-lite's answer for a stream trimmed past its tail) being
  // answered as "empty" here, before the caller has looked at the tail seq.
  it("leaves a 200 with no records for the caller to settle by the tail seq", () => {
    expect(classifyTailRead(200, JSON.stringify({ records: [] }))).toEqual({ kind: "no-records" });
    expect(classifyTailRead(200, JSON.stringify({}))).toEqual({ kind: "no-records" });
  });

  // Catches: hosted S2's 416 ("no record available", with the tail in the body) reading as "empty"
  // for a fully trimmed stream, so the run-end check scans `.in` from the run's start and starts a
  // run that re-answers messages the run already answered.
  it("reads a 416 whose tail is past 0 as commands-only", () => {
    expect(classifyTailRead(416, JSON.stringify({ tail: { seq_num: 12, timestamp: 5 } }))).toEqual({
      kind: "commands-only",
    });
  });

  it("reads a 416 whose tail is 0 as empty", () => {
    expect(classifyTailRead(416, JSON.stringify({ tail: { seq_num: 0, timestamp: 0 } }))).toEqual({
      kind: "empty",
    });
  });

  // Catches: a 416 whose body cannot be read being answered as "empty" (a duplicate-reply hazard
  // when the stream had records) instead of a failed read the caller retries.
  it("reads a 416 with a body it cannot parse as unknown", () => {
    expect(classifyTailRead(416, "not json").kind).toBe("unknown");
    expect(classifyTailRead(416, "").kind).toBe("unknown");
    expect(classifyTailRead(416, JSON.stringify({ tail: {} })).kind).toBe("unknown");
  });

  it("reads a missing stream as empty and other failures as unknown", () => {
    expect(classifyTailRead(404, "")).toEqual({ kind: "empty" });
    expect(classifyTailRead(500, "").kind).toBe("unknown");
    expect(classifyTailRead(200, "not json").kind).toBe("unknown");
  });
});

describe("parseTailSeq", () => {
  it("reads the tail seq", () => {
    expect(parseTailSeq(JSON.stringify({ tail: { seq_num: 5, timestamp: 1 } }))).toBe(5);
  });

  // Catches: a 200 tail body without a numeric seq_num being read as a tail of 0 (empty) instead
  // of a failed read.
  it("is undefined for a body without a seq_num or one that does not parse", () => {
    expect(parseTailSeq(JSON.stringify({ tail: {} }))).toBeUndefined();
    expect(parseTailSeq(JSON.stringify({ tail: { seq_num: "5" } }))).toBeUndefined();
    expect(parseTailSeq("not json")).toBeUndefined();
  });
});
