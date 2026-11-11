import { describe, expect, it } from "vitest";
import { matchesAnyManagedWorkerSecret } from "~/v3/services/worker/managedWorkerSecret.server";

describe("matchesAnyManagedWorkerSecret", () => {
  it("accepts the current secret", () => {
    expect(matchesAnyManagedWorkerSecret("current", ["current", undefined])).toBe(true);
  });

  it("accepts the previous secret while one is configured", () => {
    expect(matchesAnyManagedWorkerSecret("previous", ["current", "previous"])).toBe(true); // Catches: old supervisors 401 mid-rotation
  });

  it("rejects a secret that matches neither", () => {
    expect(matchesAnyManagedWorkerSecret("other", ["current", "previous"])).toBe(false);
  });

  it("rejects a length-mismatched secret without throwing", () => {
    expect(matchesAnyManagedWorkerSecret("curr", ["current"])).toBe(false); // Catches: timingSafeEqual length throw
  });

  it("rejects an empty presented secret even when no candidate is set", () => {
    expect(matchesAnyManagedWorkerSecret("", [undefined, undefined])).toBe(false); // Catches: unset env matching empty header
  });

  it("never treats an empty candidate as a match", () => {
    expect(matchesAnyManagedWorkerSecret("", ["", "current"])).toBe(false); // Catches: empty PREVIOUS accepting empty header
  });
});
