import { afterEach, describe, expect, test } from "vitest";
import { applyMetadataOperations } from "../src/v3/runMetadata/operations.js";
import { isSafeMetadataKey, UpdateMetadataRequestBody } from "../src/v3/schemas/index.js";
import type { RunMetadataChangeOperation } from "../src/v3/schemas/index.js";

const unsafeKeys = [
  "$.__proto__.polluted",
  "$.__proto__\\.polluted",
  "$.a\\.__proto__\\.polluted",
  "$.a.__proto__\\.polluted",
  "$.constructor\\.prototype\\.polluted",
  "$.a\\\\.__proto__.polluted",
];

describe("run metadata operation keys", () => {
  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).polluted;
  });

  test.each(unsafeKeys)("rejects %s", (key) => {
    expect(isSafeMetadataKey(key)).toBe(false);
    expect(
      UpdateMetadataRequestBody.safeParse({ operations: [{ type: "set", key, value: 41 }] }).success
    ).toBe(false);
  });

  test.each(unsafeKeys)("does not change Object.prototype through %s", (key) => {
    const operations: RunMetadataChangeOperation[] = [
      { type: "set", key, value: 41 },
      { type: "append", key, value: 41 },
      { type: "increment", key, value: 41 },
      { type: "remove", key, value: 41 },
    ];

    const { unappliedOperations } = applyMetadataOperations({ a: {} }, operations);

    expect(unappliedOperations).toHaveLength(operations.length);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("allows escaped dots around safe segments", () => {
    expect(isSafeMetadataKey("$.a\\.b")).toBe(true);
    expect(isSafeMetadataKey("$.proto\\.constructors")).toBe(true);
  });
});
