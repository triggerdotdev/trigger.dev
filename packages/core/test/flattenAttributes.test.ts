import { flattenAttributes, unflattenAttributes } from "../src/v3/utils/flattenAttributes.js";

describe("flattenAttributes", () => {
  it("handles number keys correctl", () => {
    expect(flattenAttributes({ bar: { "25": "foo" } })).toEqual({ "bar.25": "foo" });
    expect(unflattenAttributes({ "bar.25": "foo" })).toEqual({ bar: { "25": "foo" } });
    expect(flattenAttributes({ bar: ["foo", "baz"] })).toEqual({
      "bar.[0]": "foo",
      "bar.[1]": "baz",
    });
    expect(unflattenAttributes({ "bar.[0]": "foo", "bar.[1]": "baz" })).toEqual({
      bar: ["foo", "baz"],
    });
    expect(flattenAttributes({ bar: { 25: "foo" } })).toEqual({ "bar.25": "foo" });
    expect(unflattenAttributes({ "bar.25": "foo" })).toEqual({ bar: { 25: "foo" } });
  });

  it("handles null correctly", () => {
    expect(flattenAttributes(null)).toEqual({ "": "$@null((" });
    expect(unflattenAttributes({ "": "$@null((" })).toEqual(null);

    expect(flattenAttributes(null, "$output")).toEqual({ $output: "$@null((" });
    expect(flattenAttributes({ foo: null })).toEqual({ foo: "$@null((" });
    expect(unflattenAttributes({ foo: "$@null((" })).toEqual({ foo: null });

    expect(flattenAttributes({ foo: [null] })).toEqual({ "foo.[0]": "$@null((" });
    expect(unflattenAttributes({ "foo.[0]": "$@null((" })).toEqual({ foo: [null] });

    expect(flattenAttributes([null])).toEqual({ "[0]": "$@null((" });
    expect(unflattenAttributes({ "[0]": "$@null((" })).toEqual([null]);
  });

  it("flattens string attributes correctly", () => {
    const result = flattenAttributes("testString");
    expect(result).toEqual({ "": "testString" });
    expect(unflattenAttributes(result)).toEqual("testString");
  });

  it("flattens number attributes correctly", () => {
    const result = flattenAttributes(12345);
    expect(result).toEqual({ "": 12345 });
    expect(unflattenAttributes(result)).toEqual(12345);
  });

  it("flattens boolean attributes correctly", () => {
    const result = flattenAttributes(true);
    expect(result).toEqual({ "": true });
    expect(unflattenAttributes(result)).toEqual(true);
  });

  it("flattens boolean attributes correctly", () => {
    const result = flattenAttributes(true, "$output");
    expect(result).toEqual({ $output: true });
    expect(unflattenAttributes(result)).toEqual({ $output: true });
  });

  it("flattens array attributes correctly", () => {
    const input = [1, 2, 3];
    const result = flattenAttributes(input);
    expect(result).toEqual({ "[0]": 1, "[1]": 2, "[2]": 3 });
    expect(unflattenAttributes(result)).toEqual(input);
  });

  it("flattens empty array attributes correctly", () => {
    const input: number[] = [];

    const result = flattenAttributes(input);
    expect(result).toEqual({ "": "$@empty_array((" });
    expect(unflattenAttributes(result)).toEqual(input);
  });

  it("flattens empty array child attributes correctly", () => {
    const input: number[] = [];

    const result = flattenAttributes({ input });
    expect(result).toEqual({ input: "$@empty_array((" });
    expect(unflattenAttributes(result)).toEqual({ input });
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

  it("handles circular references correctly", () => {
    const user = { name: "Alice" };
    user["blogPosts"] = [{ title: "Post 1", author: user }]; // Circular reference

    const result = flattenAttributes(user);
    expect(result).toEqual({
      name: "Alice",
      "blogPosts.[0].title": "Post 1",
      "blogPosts.[0].author": "$@circular((",
    });
  });

  it("handles nested circular references correctly", () => {
    const user = { name: "Bob" };
    user["friends"] = [user]; // Circular reference

    const result = flattenAttributes(user);
    expect(result).toEqual({
      name: "Bob",
      "friends.[0]": "$@circular((",
    });
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

  it("correctly reconstructs empty arrays", () => {
    const flattened = {
      "": "$@empty_array((",
      array1: "$@empty_array((",
      "array2.[0]": "$@empty_array((",
    };
    const expected = {
      "": [],
      array1: [],
      array2: [[]],
    };
    expect(unflattenAttributes(flattened)).toEqual(expected);
  });

  it("rehydrates circular references correctly", () => {
    const flattened = {
      name: "Alice",
      "blogPosts.[0].title": "Post 1",
      "blogPosts.[0].author": "$@circular((",
    };

    const result = unflattenAttributes(flattened);
    expect(result).toEqual({
      name: "Alice",
      blogPosts: [{ title: "Post 1", author: "[Circular Reference]" }],
    });
  });
});
