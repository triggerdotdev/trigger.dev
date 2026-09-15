import { describe, expect, it } from "vitest";
import { removeNullBytes, removeNullBytesFromKey } from "./nullBytes";

describe("removeNullBytes", () => {
  it("strips every NUL from a string", () => {
    expect(removeNullBytes(`a\u0000b\u0000c`)).toBe("abc");
  });

  it("returns the same reference when there is no NUL", () => {
    const clean = "acme-inc";
    expect(removeNullBytes(clean)).toBe(clean);
  });

  it("passes through undefined and null", () => {
    expect(removeNullBytes(undefined)).toBeUndefined();
    expect(removeNullBytes(null)).toBeNull();
  });
});

describe("removeNullBytesFromKey", () => {
  it("strips a NUL from the key while preserving other fields", () => {
    expect(removeNullBytesFromKey({ key: `k\u00001`, scope: "run" })).toEqual({
      key: "k1",
      scope: "run",
    });
  });

  it("returns the same object reference when the key is clean", () => {
    const opts = { key: "clean", scope: "run" };
    expect(removeNullBytesFromKey(opts)).toBe(opts);
  });

  it("passes through undefined", () => {
    expect(removeNullBytesFromKey(undefined)).toBeUndefined();
  });
});
