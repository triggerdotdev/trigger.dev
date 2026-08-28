import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, it } from "vitest";
import { isRunFriendlyId } from "./run-id";

describe("isRunFriendlyId", () => {
  it("matches ids the platform actually mints", () => {
    for (let i = 0; i < 50; i++) {
      expect(isRunFriendlyId(generateFriendlyId("run"))).toBe(true);
    }
  });

  it("matches a run-ops v1 id (base32hex body + region + version)", () => {
    expect(isRunFriendlyId("run_0abcdefghijklmnopqrstuvw1")).toBe(true);
  });

  it("matches a legacy cuid-bodied id", () => {
    expect(isRunFriendlyId("run_clq1x2y3z0000abcd1efgh2ij")).toBe(true);
  });

  it("matches an id the user typed in caps", () => {
    expect(isRunFriendlyId("RUN_ABC123")).toBe(true);
  });

  it("rejects other entities and non-ids", () => {
    expect(isRunFriendlyId("error_abc123")).toBe(false);
    expect(isRunFriendlyId("batch_abc123")).toBe(false);
    expect(isRunFriendlyId("run_")).toBe(false);
    expect(isRunFriendlyId("run")).toBe(false);
    expect(isRunFriendlyId("src/trigger/tasks.ts:42")).toBe(false);
    expect(isRunFriendlyId("https://example.com/run_abc")).toBe(false);
    expect(isRunFriendlyId("run_abc-attempt-1")).toBe(false);
  });
});
