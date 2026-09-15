import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_URIS_PER_RESOLVE_REQUEST, planUriBatches, shouldScheduleRetry } from "./resolve-uris";

const uri = (index: number) => `trigger://runs/run_${index}`;

describe("planUriBatches", () => {
  it("resolves a card's twenty citations in one request", () => {
    const batches = planUriBatches(Array.from({ length: 20 }, (_, index) => uri(index)));

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(20);
  });

  it("asks about each URI once", () => {
    const batches = planUriBatches([uri(1), uri(1), uri(2)]);

    expect(batches).toEqual([[uri(1), uri(2)]]);
  });

  it("caps a request and carries the rest over", () => {
    const count = MAX_URIS_PER_RESOLVE_REQUEST + 3;
    const batches = planUriBatches(Array.from({ length: count }, (_, index) => uri(index)));

    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(MAX_URIS_PER_RESOLVE_REQUEST);
    expect(batches[1]).toHaveLength(3);
  });

  it("has nothing to send for nothing", () => {
    expect(planUriBatches([])).toEqual([]);
  });
});

describe("shouldScheduleRetry", () => {
  it("retries a transient failure while the cards are still on screen", () => {
    expect(shouldScheduleRetry({ mounted: true, timerPending: false })).toBe(true);
  });

  it("schedules nothing once the panel is gone", () => {
    // A request in flight at unmount rejects afterwards; its retry would fetch
    // again and set state for a component that no longer exists.
    expect(shouldScheduleRetry({ mounted: false, timerPending: false })).toBe(false);
    expect(shouldScheduleRetry({ mounted: false, timerPending: true })).toBe(false);
  });

  it("lets one timer serve every batch", () => {
    expect(shouldScheduleRetry({ mounted: true, timerPending: true })).toBe(false);
  });
});

/**
 * Structural guard, not behavioural proof: the webapp has no DOM test environment, so nothing
 * here mounts the hook or unmounts it mid-flight. It asserts the policy above is the one the
 * hook asks, and that the unmount path is wired.
 */
describe("useTriggerUriResolver's unmount wiring", () => {
  const source = readFileSync(new URL("./useTriggerUriResolver.ts", import.meta.url), "utf8");

  it("asks `shouldScheduleRetry` rather than testing the timer itself", () => {
    expect(source).toContain("shouldScheduleRetry({");
    expect(source).not.toMatch(/if \(retryTimer\.current === undefined\)/);
  });

  it("marks itself unmounted on cleanup and drops state updates after that", () => {
    expect(source).toContain("mounted.current = false");
    expect(source).toContain("if (!mounted.current) return;");
  });
});
