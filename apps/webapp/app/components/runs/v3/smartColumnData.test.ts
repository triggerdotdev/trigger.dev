import superjson from "superjson";
import { describe, expect, it } from "vitest";
import {
  extractSmartValue,
  getAtPath,
  labelFromPath,
  parseSource,
} from "./smartColumnData";

describe("parseSource", () => {
  it("reports empty for missing data", () => {
    expect(parseSource({ data: null, dataType: "application/json" })).toEqual({ state: "empty" });
    expect(parseSource({ data: undefined, dataType: "application/json" })).toEqual({
      state: "empty",
    });
    expect(parseSource({ data: "", dataType: "application/json" })).toEqual({ state: "empty" });
  });

  it("reports offloaded for application/store without touching the path", () => {
    expect(parseSource({ data: "s3://bucket/key", dataType: "application/store" })).toEqual({
      state: "offloaded",
    });
  });

  it("parses application/json", () => {
    expect(parseSource({ data: '{"a":1}', dataType: "application/json" })).toEqual({
      state: "parsed",
      value: { a: 1 },
    });
  });

  it("parses application/super+json (dates survive)", () => {
    const serialized = superjson.stringify({ when: new Date("2026-01-01T00:00:00.000Z"), n: 2 });
    const parsed = parseSource({ data: serialized, dataType: "application/super+json" });
    expect(parsed.state).toBe("parsed");
    if (parsed.state === "parsed") {
      const value = parsed.value as { when: Date; n: number };
      expect(value.when).toBeInstanceOf(Date);
      expect(value.n).toBe(2);
    }
  });

  it("defaults an unknown/absent content type to raw string and json respectively", () => {
    expect(parseSource({ data: "hello", dataType: "text/plain" })).toEqual({
      state: "parsed",
      value: "hello",
    });
    expect(parseSource({ data: '{"a":1}', dataType: undefined })).toEqual({
      state: "parsed",
      value: { a: 1 },
    });
  });

  it("falls back to the raw string on malformed json", () => {
    expect(parseSource({ data: "{not json", dataType: "application/json" })).toEqual({
      state: "parsed",
      value: "{not json",
    });
  });
});

describe("getAtPath", () => {
  const obj = {
    failed: 3,
    suites: [{ name: "nightly" }, { name: "smoke" }],
    "a.b": { c: 7 },
    nested: { deep: { value: "x" } },
  };

  it("reads a top-level key with and without $ / dot prefixes", () => {
    expect(getAtPath(obj, "$.failed")).toBe(3);
    expect(getAtPath(obj, "failed")).toBe(3);
    expect(getAtPath(obj, ".failed")).toBe(3);
  });

  it("reads array indices and nested keys", () => {
    expect(getAtPath(obj, "$.suites[0].name")).toBe("nightly");
    expect(getAtPath(obj, "suites[1].name")).toBe("smoke");
    expect(getAtPath(obj, "nested.deep.value")).toBe("x");
  });

  it("reads quoted bracket keys containing a dot", () => {
    expect(getAtPath(obj, "$['a.b'].c")).toBe(7);
  });

  it("returns undefined for missing segments", () => {
    expect(getAtPath(obj, "$.nope")).toBeUndefined();
    expect(getAtPath(obj, "$.suites[9].name")).toBeUndefined();
    expect(getAtPath(obj, "$.failed.x")).toBeUndefined();
  });

  it("rejects malformed paths", () => {
    expect(getAtPath(obj, "$.a..b")).toBeUndefined();
    expect(getAtPath(obj, "$.a[b]")).toBeUndefined();
  });
});

describe("extractSmartValue", () => {
  it("passes through empty and offloaded states", () => {
    expect(extractSmartValue({ state: "empty" }, "$.a")).toEqual({ state: "empty" });
    expect(extractSmartValue({ state: "offloaded" }, "$.a")).toEqual({ state: "offloaded" });
  });

  it("returns the value when present and empty when absent", () => {
    const parsed = { state: "parsed" as const, value: { a: { b: 5 } } };
    expect(extractSmartValue(parsed, "$.a.b")).toEqual({ state: "value", value: 5 });
    expect(extractSmartValue(parsed, "$.a.c")).toEqual({ state: "empty" });
  });
});

describe("labelFromPath", () => {
  it("uses the last segment", () => {
    expect(labelFromPath("$.suites[0].name")).toBe("name");
    expect(labelFromPath("$.failed")).toBe("failed");
    expect(labelFromPath("failed")).toBe("failed");
  });
});
