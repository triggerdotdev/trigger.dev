import { assertExhaustive, tryCatch, promiseWithResolvers } from "../src/utils.js";

describe("assertExhaustive", () => {
  it("should throw an error when called", () => {
    expect(() => assertExhaustive("unexpected" as never)).toThrow(Error);
  });
});

describe("tryCatch", () => {
  it("should resolve with [null, value] when promise resolves", async () => {
    const promise = Promise.resolve(42);
    const result = await tryCatch(promise);
    expect(result).toEqual([null, 42]);
  });

  it("should resolve with [error, null] when promise rejects", async () => {
    const error = new Error("fail");
    const promise = Promise.reject(error);
    const result = await tryCatch(promise);
    expect(result[0]).toBe(error);
    expect(result[1]).toBeNull();
  });

  it("should resolve with [error, null] when promise throws non-Error", async () => {
    const promise = Promise.reject("fail");
    const result = await tryCatch(promise);
    expect(result[0]).toBe("fail");
    expect(result[1]).toBeNull();
  });

  it("should resolve with [null, undefined] when promise resolves to undefined", async () => {
    const promise = Promise.resolve(undefined);
    const result = await tryCatch(promise);
    expect(result).toEqual([null, undefined]);
  });

  it("should resolve with [null, value] when promise is already resolved", async () => {
    const resolved = Promise.resolve("done");
    const result = await tryCatch(resolved);
    expect(result).toEqual([null, "done"]);
  });

  it("should resolve with [null, undefined] when promise is undefined", async () => {
    const result = await tryCatch(undefined);
    expect(result).toEqual([null, undefined]);
  });
});

describe("promiseWithResolvers", () => {
  it("should return a deferred promise with resolve and reject", async () => {
    const deferred = promiseWithResolvers<number>();
    expect(typeof deferred.promise.then).toBe("function");
    expect(typeof deferred.resolve).toBe("function");
    expect(typeof deferred.reject).toBe("function");
    let resolved = false;
    deferred.promise.then((value: number) => {
      expect(value).toBe(123);
      resolved = true;
    });
    deferred.resolve(123);
    await deferred.promise;
    expect(resolved).toBe(true);
  });

  it("should reject the promise when reject is called", async () => {
    const deferred = promiseWithResolvers<string>();
    const error = new Error("fail");
    let caught: Error | null = null;
    deferred.promise.catch((e: Error) => {
      caught = e;
    });
    deferred.reject(error);
    await expect(deferred.promise).rejects.toBe(error);
    expect(caught).toBe(error);
  });

  it("should allow resolving with undefined", async () => {
    const deferred = promiseWithResolvers<void>();
    let resolved = false;
    deferred.promise.then((value: void) => {
      expect(value).toBeUndefined();
      resolved = true;
    });
    deferred.resolve();
    await deferred.promise;
    expect(resolved).toBe(true);
  });
});
