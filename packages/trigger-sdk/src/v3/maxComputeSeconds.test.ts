import { describe, it, expect } from "vitest";
import { resolveMaxComputeSeconds } from "./maxComputeSeconds.js";

describe("resolveMaxComputeSeconds", () => {
  it("returns maxComputeSeconds when only maxComputeSeconds is set", () => {
    expect(resolveMaxComputeSeconds({ maxComputeSeconds: 300 })).toBe(300);
  });

  it("returns maxDuration when only maxDuration is set", () => {
    expect(resolveMaxComputeSeconds({ maxDuration: 300 })).toBe(300);
  });

  it("prefers maxComputeSeconds when both are set", () => {
    expect(resolveMaxComputeSeconds({ maxComputeSeconds: 300, maxDuration: 999 })).toBe(300);
  });

  it("returns undefined when neither is set", () => {
    expect(resolveMaxComputeSeconds({})).toBeUndefined();
  });
});
