import { flattenAttributes, unflattenAttributes } from "../src/v3/utils/flattenAttributes";

describe("flattenAttributes", () => {
  it("handles null and undefined gracefully", () => {
    expect(flattenAttributes(null)).toEqual({});
    expect(flattenAttributes(undefined)).toEqual({});
  });

  it("flattens string attributes correctly", () => {
    const result = flattenAttributes("testString");
    expect(result).toEqual({ "": "testString" });
  });

  it("flattens number attributes correctly", () => {
    const result = flattenAttributes(12345);
    expect(result).toEqual({ "": 12345 });
  });

  it("flattens boolean attributes correctly", () => {
    const result = flattenAttributes(true);
    expect(result).toEqual({ "": true });
  });

  it("flattens complex objects correctly", () => {
    const obj = {
      level1: {
        level2: {
          value: "test",
        },
        array: [1, 2, 3],
      },
    };
    const expected = {
      "level1.level2.value": "test",
      "level1.array.[0]": 1,
      "level1.array.[1]": 2,
      "level1.array.[2]": 3,
    };
    expect(flattenAttributes(obj)).toEqual(expected);
  });

  it("applies prefixes correctly", () => {
    const obj = { key: "value" };
    const expected = { "prefix.key": "value" };
    expect(flattenAttributes(obj, "prefix")).toEqual(expected);
  });

  it("handles arrays of objects correctly", () => {
    const obj = {
      array: [{ key: "value" }, { key: "value" }, { key: "value" }],
    };
    const expected = {
      "array.[0].key": "value",
      "array.[1].key": "value",
      "array.[2].key": "value",
    };
    expect(flattenAttributes(obj)).toEqual(expected);
  });

  it("handles arrays of objects correctly with prefixing correctly", () => {
    const obj = {
      array: [{ key: "value" }, { key: "value" }, { key: "value" }],
    };
    const expected = {
      "prefix.array.[0].key": "value",
      "prefix.array.[1].key": "value",
      "prefix.array.[2].key": "value",
    };
    expect(flattenAttributes(obj, "prefix")).toEqual(expected);
  });

  it("handles objects of objects correctly", () => {
    const obj = {
      level1: {
        level2: {
          key: "value",
        },
      },
    };
    const expected = { "level1.level2.key": "value" };
    expect(flattenAttributes(obj)).toEqual(expected);
  });

  it("handles objects of objects correctly with prefixing", () => {
    const obj = {
      level1: {
        level2: {
          key: "value",
        },
      },
    };
    const expected = { "prefix.level1.level2.key": "value" };
    expect(flattenAttributes(obj, "prefix")).toEqual(expected);
  });

  it("handles retry.byStatus correctly", () => {
    const obj = {
      "500": {
        strategy: "backoff",
        maxAttempts: 2,
        factor: 2,
        minTimeoutInMs: 1_000,
        maxTimeoutInMs: 30_000,
        randomize: false,
      },
    };

    const expected = {
      "retry.byStatus.500.strategy": "backoff",
      "retry.byStatus.500.maxAttempts": 2,
      "retry.byStatus.500.factor": 2,
      "retry.byStatus.500.minTimeoutInMs": 1_000,
      "retry.byStatus.500.maxTimeoutInMs": 30_000,
      "retry.byStatus.500.randomize": false,
    };

    expect(flattenAttributes(obj, "retry.byStatus")).toEqual(expected);
  });
});

describe("unflattenAttributes", () => {
  it("returns the original object for primitive types", () => {
    // @ts-expect-error
    expect(unflattenAttributes("testString")).toEqual("testString");
    // @ts-expect-error
    expect(unflattenAttributes(12345)).toEqual(12345);
    // @ts-expect-error
    expect(unflattenAttributes(true)).toEqual(true);
  });

  it("correctly reconstructs an object from flattened attributes", () => {
    const flattened = {
      "level1.level2.value": "test",
      "level1.array.[0]": 1,
      "level1.array.[1]": 2,
      "level1.array.[2]": 3,
    };
    const expected = {
      level1: {
        level2: {
          value: "test",
        },
        array: [1, 2, 3],
      },
    };
    expect(unflattenAttributes(flattened)).toEqual(expected);
  });

  it("handles complex nested objects with mixed types", () => {
    const flattened = {
      "user.details.name": "John Doe",
      "user.details.age": 30,
      "user.preferences.colors.[0]": "blue",
      "user.preferences.colors.[1]": "green",
      "user.active": true,
    };
    const expected = {
      user: {
        details: {
          name: "John Doe",
          age: 30,
        },
        preferences: {
          colors: ["blue", "green"],
        },
        active: true,
      },
    };
    expect(unflattenAttributes(flattened)).toEqual(expected);
  });

  it("correctly identifies arrays vs objects", () => {
    const flattened = {
      "array.[0]": 1,
      "array.[1]": 2,
      "object.key": "value",
    };
    const expected = {
      array: [1, 2],
      object: {
        key: "value",
      },
    };
    expect(unflattenAttributes(flattened)).toEqual(expected);
  });
});
