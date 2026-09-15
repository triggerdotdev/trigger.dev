import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * There is no rendering harness here, so this pins the prop that decides the tab order
 * rather than the tab order itself: `SimpleTooltip` sets `tabIndex={-1}` unless `tabbable`
 * is passed. What it does not prove is that focus actually opens the tooltip.
 */
describe("the watch chip's tooltips are reachable by keyboard", () => {
  const source = readFileSync(new URL("./WatchChips.tsx", import.meta.url), "utf8");

  it("marks both tabbable — the label one carries status, cadence and expiry", () => {
    expect(source.match(/<SimpleTooltip/g) ?? []).toHaveLength(2);
    expect(source.match(/\btabbable\b/g) ?? []).toHaveLength(2);
  });
});
