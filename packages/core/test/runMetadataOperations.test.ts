import { JSONHeroPath } from "@jsonhero/path";
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

// Unit test by exception: which keys the path library reads as the root is stable, and the SDK and API share this check.
describe("root-only metadata paths", () => {
  test.each(["$.", "$..", "$.\\"])(
    "rejects %s, which names nothing below the root, and leaves it unapplied",
    (key) => {
      expect(isSafeMetadataKey(key)).toBe(false);
      expect(
        UpdateMetadataRequestBody.safeParse({ operations: [{ type: "set", key, value: 1 }] })
          .success
      ).toBe(false);
      expect(applyMetadataOperations({ a: 1 }, [{ type: "set", key, value: 1 }])).toEqual({
        newMetadata: { a: 1 },
        unappliedOperations: [{ type: "set", key, value: 1 }],
      });
    }
  );

  test.each(["$", "$.a", "$.items.*.status", "$.[]", "$.''"])("accepts %s", (key) => {
    expect(isSafeMetadataKey(key)).toBe(true);
  });
});

describe("wildcard metadata keys", () => {
  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).polluted;
  });

  const isPolluted = () => ({} as Record<string, unknown>).polluted !== undefined;

  // Catches: a multi-segment literal key with a dangerous segment passing validation.
  test("rejects a literal key with a dangerous segment", () => {
    expect(
      UpdateMetadataRequestBody.safeParse({
        operations: [
          { type: "set", key: "__proto__.polluted", value: true },
          { type: "set", key: "$.*", value: true },
        ],
      }).success
    ).toBe(false);
    expect(isSafeMetadataKey("constructor.prototype.polluted")).toBe(false);
  });

  test("accepts single-segment literal keys other than __proto__", () => {
    expect(isSafeMetadataKey("constructor")).toBe(true);
    expect(isSafeMetadataKey("prototype")).toBe(true);
    expect(isSafeMetadataKey("__proto__")).toBe(false);
  });

  const wildcardOperations: RunMetadataChangeOperation[] = [
    { type: "set", key: "$.*", value: true },
    { type: "set", key: "$.*.polluted", value: true },
    { type: "append", key: "$.*", value: true },
    { type: "increment", key: "$.*", value: 1 },
    { type: "remove", key: "$.*", value: true },
  ];

  // Catches: a wildcard expanding to a dangerous path through existing metadata keys.
  test.each(wildcardOperations)(
    "leaves $type $key unapplied when it expands to a dangerous path",
    (operation) => {
      const { unappliedOperations } = applyMetadataOperations(
        { "__proto__.polluted": [true], "constructor.prototype.polluted": [true] },
        [operation]
      );

      expect(unappliedOperations).toEqual([operation]);
      expect(isPolluted()).toBe(false);
    }
  );

  test("leaves a wildcard unapplied over keys written by an update op", () => {
    const { unappliedOperations } = applyMetadataOperations({}, [
      { type: "update", value: { "__proto__.polluted": 1 } },
      { type: "set", key: "$.*", value: true },
    ]);

    expect(unappliedOperations).toHaveLength(1);
    expect(isPolluted()).toBe(false);
  });

  test("leaves a wildcard unapplied over keys written by a set value", () => {
    const { unappliedOperations } = applyMetadataOperations({}, [
      { type: "set", key: "$.nested", value: { "__proto__.polluted": 1 } },
      { type: "set", key: "$.nested.*", value: true },
    ]);

    expect(unappliedOperations).toHaveLength(1);
    expect(isPolluted()).toBe(false);
  });

  // Catches: the path library reading a slice component differently on consecutive parses, so the
  // check and the write walk different paths.
  test.each([false, true])(
    "leaves a slice-bearing key unapplied whatever the parser state (primed: %s)",
    (primed) => {
      if (primed) {
        new JSONHeroPath("$.items.[0:]");
      }
      const operations: RunMetadataChangeOperation[] = [
        {
          type: "update",
          value: { "[:]": { "__proto__.polluted": 1 }, "[0]": {} },
        },
        { type: "set", key: "$.[:].*", value: true },
      ];

      expect(UpdateMetadataRequestBody.safeParse({ operations: operations.slice(1) }).success).toBe(
        false
      );
      for (let attempt = 0; attempt < 3; attempt++) {
        const { unappliedOperations } = applyMetadataOperations({}, operations);
        expect(unappliedOperations).toEqual([operations[1]]);
      }
      expect(isPolluted()).toBe(false);
    }
  );

  test("applies a wildcard over safe keys", () => {
    const { newMetadata, unappliedOperations } = applyMetadataOperations(
      { items: { a: { status: "queued" }, b: { status: "queued" } } },
      [{ type: "set", key: "$.items.*.status", value: "done" }]
    );

    expect(unappliedOperations).toEqual([]);
    expect(newMetadata).toEqual({ items: { a: { status: "done" }, b: { status: "done" } } });
  });
});
