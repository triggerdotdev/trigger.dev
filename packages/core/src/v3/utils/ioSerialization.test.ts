import { describe, expect, it } from "vitest";
import { stringifyIO } from "./ioSerialization.js";

describe("stringifyIO", () => {
  it("returns undefined data for undefined input", async () => {
    const result = await stringifyIO(undefined);
    expect(result).toEqual({ dataType: "application/json" });
  });

  it("returns plain text for string input", async () => {
    const result = await stringifyIO("hello world");
    expect(result).toEqual({ data: "hello world", dataType: "text/plain" });
  });

  it("serializes normal objects using super+json", async () => {
    const result = await stringifyIO({ key: "value", num: 42 });
    expect(result.dataType).toEqual("application/super+json");
    expect(typeof result.data).toBe("string");
  });

  it("fallback returns string data when superjson fails", async () => {
    // Create an object where superjson.stringify throws or handles non-standard values
    const cyclic: any = { name: "test" };
    cyclic.self = cyclic;

    const result = await stringifyIO(cyclic);
    expect(typeof result.data).toBe("string");
  });
});
