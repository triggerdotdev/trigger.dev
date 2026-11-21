import { describe, expect, it } from "vitest";
import { UpdateMetadataResponseBody } from "./api.js";

describe("UpdateMetadataResponseBody", () => {
  it("parses an object metadata payload", () => {
    const result = UpdateMetadataResponseBody.safeParse({
      metadata: { key: "value", count: 2 },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata).toEqual({ key: "value", count: 2 });
    }
  });

  it("parses a metadata payload returned as a JSON string", () => {
    const result = UpdateMetadataResponseBody.safeParse({
      metadata: '{"key":"value","count":2}',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata).toEqual({ key: "value", count: 2 });
    }
  });

  it("rejects a metadata payload that is neither object nor valid JSON", () => {
    const result = UpdateMetadataResponseBody.safeParse({ metadata: "not-json" });

    expect(result.success).toBe(false);
  });
});
