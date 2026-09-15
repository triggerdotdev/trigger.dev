import { describe, expect, it } from "vitest";
import { encodeTaskIdForPath } from "./encodeTaskIdForPath.js";

describe("encodeTaskIdForPath", () => {
  it("percent-encodes a plain id unchanged", () => {
    expect(encodeTaskIdForPath("my-task")).toBe("my-task");
  });

  it("percent-encodes a slash so the id stays a single path segment", () => {
    expect(encodeTaskIdForPath("types/zod")).toBe("types%2Fzod");
    expect(encodeTaskIdForPath("/jobs/my-task")).toBe("%2Fjobs%2Fmy-task");
  });

  it("throws a clear error for an id that cannot be encoded into a URL", () => {
    expect(() => encodeTaskIdForPath("bad\uD800id")).toThrowError(/Invalid task id/);
  });
});
