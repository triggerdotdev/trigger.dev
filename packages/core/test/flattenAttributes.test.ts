import { flattenAttributes, unflattenAttributes } from "../src/v3/utils/flattenAttributes.js";

describe("flattenAttributes", () => {
  it("handles number keys correctly", () => {
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

  it("flattens properties that are undefined correctly", () => {
    const result = flattenAttributes({ foo: undefined, bar: "baz" });
    expect(result).toEqual({ bar: "baz" });
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
    // @ts-expect-error
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
    // @ts-expect-error
    user["friends"] = [user]; // Circular reference

    const result = flattenAttributes(user);
    expect(result).toEqual({
      name: "Bob",
      "friends.[0]": "$@circular((",
    });
  });

  it("respects maxAttributeCount limit", () => {
    const obj = {
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
    };

    const result = flattenAttributes(obj, undefined, 3);
    expect(Object.keys(result)).toHaveLength(3);
    expect(result).toEqual({
      a: 1,
      b: 2,
      c: 3,
    });
  });

  it("respects maxAttributeCount limit with nested objects", () => {
    const obj = {
      level1: {
        a: 1,
        b: 2,
        c: 3,
      },
      level2: {
        d: 4,
        e: 5,
      },
    };

    const result = flattenAttributes(obj, undefined, 2);
    expect(Object.keys(result)).toHaveLength(2);
    expect(result).toEqual({
      "level1.a": 1,
      "level1.b": 2,
    });
  });

  it("respects maxAttributeCount limit with arrays", () => {
    const obj = {
      array: [1, 2, 3, 4, 5],
    };

    const result = flattenAttributes(obj, undefined, 3);
    expect(Object.keys(result)).toHaveLength(3);
    expect(result).toEqual({
      "array.[0]": 1,
      "array.[1]": 2,
      "array.[2]": 3,
    });
  });

  it("works normally when maxAttributeCount is undefined", () => {
    const obj = {
      a: 1,
      b: 2,
      c: 3,
    };

    const result = flattenAttributes(obj);
    expect(Object.keys(result)).toHaveLength(3);
    expect(result).toEqual({
      a: 1,
      b: 2,
      c: 3,
    });
  });

  it("handles maxAttributeCount of 0", () => {
    const obj = {
      a: 1,
      b: 2,
    };

    const result = flattenAttributes(obj, undefined, 0);
    expect(Object.keys(result)).toHaveLength(0);
    expect(result).toEqual({});
  });

  it("handles maxAttributeCount with primitive values", () => {
    const result1 = flattenAttributes("test", undefined, 1);
    expect(result1).toEqual({ "": "test" });

    const result2 = flattenAttributes("test", undefined, 0);
    expect(result2).toEqual({});
  });

  it("handles Error objects correctly", () => {
    const error = new Error("Test error message");
    error.stack = "Error: Test error message\n    at test.js:1:1";

    const result = flattenAttributes({ error });
    expect(result).toEqual({
      "error.name": "Error",
      "error.message": "Test error message",
      "error.stack": "Error: Test error message\n    at test.js:1:1",
    });
  });

  it("handles Error objects as top-level values", () => {
    const error = new Error("Top level error");
    const result = flattenAttributes(error);
    expect(result["error.name"]).toBe("Error");
    expect(result["error.message"]).toBe("Top level error");
    // Stack trace is also included when present
    expect(result["error.stack"]).toBeDefined();
  });

  it("handles function values correctly", () => {
    function namedFunction() {}
    const anonymousFunction = function () {};
    const arrowFunction = () => {};

    const result = flattenAttributes({
      named: namedFunction,
      anonymous: anonymousFunction,
      arrow: arrowFunction,
    });

    expect(result.named).toBe("[Function: namedFunction]");
    // Note: function expressions with variable names retain their names
    expect(result.anonymous).toBe("[Function: anonymousFunction]");
    // Arrow functions also get their variable names in modern JS
    expect(result.arrow).toBe("[Function: arrowFunction]");
  });

  it("handles mixed problematic types", () => {
    const complexObj = {
      error: new Error("Mixed error"),
      func: function testFunc() {},
      date: new Date("2023-01-01"),
      normal: "string",
      number: 42,
    };

    const result = flattenAttributes(complexObj);

    expect(result["error.name"]).toBe("Error");
    expect(result["error.message"]).toBe("Mixed error");
    expect(result["func"]).toBe("[Function: testFunc]");
    expect(result["date"]).toBe("2023-01-01T00:00:00.000Z");
    expect(result["normal"]).toBe("string");
    expect(result["number"]).toBe(42);
  });

  it("handles bigint and symbol types", () => {
    const obj = {
      bigNumber: BigInt(123456789),
      sym: Symbol("test"),
    };

    const result = flattenAttributes(obj);
    expect(result["bigNumber"]).toBe("123456789");
    expect(result["sym"]).toBe("Symbol(test)");
  });

  it("handles Set objects correctly", () => {
    const mySet = new Set([1, "hello", true, { nested: "object" }]);
    const result = flattenAttributes({ mySet });

    expect(result["mySet.[0]"]).toBe(1);
    expect(result["mySet.[1]"]).toBe("hello");
    expect(result["mySet.[2]"]).toBe(true);
    expect(result["mySet.[3].nested"]).toBe("object");
  });

  it("handles nested Set objects correctly", () => {
    const mySet = new Set([1, 2, 3, { nested: "object" }]);
    const result = flattenAttributes({ mySet });
    expect(result["mySet.[0]"]).toBe(1);
    expect(result["mySet.[1]"]).toBe(2);
    expect(result["mySet.[2]"]).toBe(3);
    expect(result["mySet.[3].nested"]).toBe("object");
  });

  it("handles Map objects correctly", () => {
    const myMap = new Map();
    myMap.set("key1", "value1");
    myMap.set("key2", 42);
    myMap.set(123, "numeric key");

    const result = flattenAttributes({ myMap });

    expect(result["myMap.key1"]).toBe("value1");
    expect(result["myMap.key2"]).toBe(42);
    expect(result["myMap.123"]).toBe("numeric key");
  });

  it("handles nested Map objects correctly", () => {
    const myMap = new Map();
    myMap.set("key1", {
      key2: "value2",
      key3: 42,
    });
    const result = flattenAttributes({ myMap });
    expect(result["myMap.key1.key2"]).toBe("value2");
    expect(result["myMap.key1.key3"]).toBe(42);
  });

  it("handles File objects correctly", () => {
    if (typeof File !== "undefined") {
      const file = new File(["content"], "test.txt", {
        type: "text/plain",
        lastModified: 1640995200000,
      });
      const result = flattenAttributes({ file });

      expect(result["file.name"]).toBe("test.txt");
      expect(result["file.type"]).toBe("text/plain");
      expect(result["file.size"]).toBe(7); // "content" is 7 bytes
      expect(result["file.lastModified"]).toBe(1640995200000);
    }
  });

  it("handles ReadableStream objects correctly", () => {
    if (typeof ReadableStream !== "undefined") {
      const stream = new ReadableStream();
      const result = flattenAttributes({ stream });

      expect(result["stream.type"]).toBe("ReadableStream");
      expect(result["stream.locked"]).toBe(false);
    }
  });

  it("handles Promise objects correctly", () => {
    const resolvedPromise = Promise.resolve("value");
    const rejectedPromise = Promise.reject(new Error("failed"));
    const pendingPromise = new Promise(() => {}); // Never resolves

    // Catch the rejection to avoid unhandled promise rejection warnings
    rejectedPromise.catch(() => {});

    const result = flattenAttributes({
      resolved: resolvedPromise,
      rejected: rejectedPromise,
      pending: pendingPromise,
    });

    expect(result["resolved"]).toBe("[Promise object]");
    expect(result["rejected"]).toBe("[Promise object]");
    expect(result["pending"]).toBe("[Promise object]");
  });

  it("handles RegExp objects correctly", () => {
    const regex = /hello.*world/gim;
    const result = flattenAttributes({ regex });

    expect(result["regex.source"]).toBe("hello.*world");
    expect(result["regex.flags"]).toBe("gim");
  });

  it("handles URL objects correctly", () => {
    if (typeof URL !== "undefined") {
      const url = new URL("https://example.com:8080/path?query=value#fragment");
      const result = flattenAttributes({ url });

      expect(result["url.href"]).toBe("https://example.com:8080/path?query=value#fragment");
      expect(result["url.protocol"]).toBe("https:");
      expect(result["url.host"]).toBe("example.com:8080");
      expect(result["url.pathname"]).toBe("/path");
    }
  });

  it("handles ArrayBuffer correctly", () => {
    const buffer = new ArrayBuffer(16);
    const result = flattenAttributes({ buffer });

    expect(result["buffer.byteLength"]).toBe(16);
  });

  it("handles TypedArrays correctly", () => {
    const uint8Array = new Uint8Array([1, 2, 3, 4]);
    const int32Array = new Int32Array([100, 200, 300]);

    const result = flattenAttributes({
      uint8: uint8Array,
      int32: int32Array,
    });

    expect(result["uint8.constructor"]).toBe("Uint8Array");
    expect(result["uint8.length"]).toBe(4);
    expect(result["uint8.byteLength"]).toBe(4);
    expect(result["uint8.byteOffset"]).toBe(0);

    expect(result["int32.constructor"]).toBe("Int32Array");
    expect(result["int32.length"]).toBe(3);
    expect(result["int32.byteLength"]).toBe(12); // 3 * 4 bytes
    expect(result["int32.byteOffset"]).toBe(0);
  });

  it("handles complex mixed object with all special types", () => {
    const complexObj = {
      error: new Error("Test error"),
      func: function testFunc() {},
      date: new Date("2023-01-01"),
      mySet: new Set([1, 2, 3]),
      myMap: new Map([["key", "value"]]),
      regex: /test/gi,
      bigint: BigInt(999),
      symbol: Symbol("test"),
    };

    const result = flattenAttributes(complexObj);

    // Verify we get reasonable representations for all types
    expect(result["error.name"]).toBe("Error");
    expect(result["func"]).toBe("[Function: testFunc]");
    expect(result["date"]).toBe("2023-01-01T00:00:00.000Z");
    expect(result["regex.source"]).toBe("test");
    expect(result["bigint"]).toBe("999");
    expect(typeof result["symbol"]).toBe("string");
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
