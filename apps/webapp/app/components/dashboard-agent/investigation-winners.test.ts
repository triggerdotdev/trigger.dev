import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reuseWinners, sameOccurrences } from "./investigation-winners";

describe("reuseWinners", () => {
  it("keeps the previous map when the winners are unchanged", () => {
    const first = new Map([["inv_1", "msg_a:0"]]);
    const second = new Map([["inv_1", "msg_a:0"]]);
    expect(sameOccurrences(first, second)).toBe(true);
    expect(reuseWinners(first, second)).toBe(first);
  });

  it("takes the next map when a winner moves", () => {
    const first = new Map([["inv_1", "msg_a:0"]]);
    const moved = new Map([["inv_1", "msg_b:2"]]);
    expect(reuseWinners(first, moved)).toBe(moved);
  });

  it("takes the next map when an investigation appears", () => {
    const first = new Map([["inv_1", "msg_a:0"]]);
    const grown = new Map([
      ["inv_1", "msg_a:0"],
      ["inv_2", "msg_b:1"],
    ]);
    expect(reuseWinners(first, grown)).toBe(grown);
  });

  it("takes the next map on the first render", () => {
    const only = new Map([["inv_1", "msg_a:0"]]);
    expect(reuseWinners(undefined, only)).toBe(only);
  });
});

// Structural: there is no jsdom here, so the wiring is asserted against the source.
describe("DashboardAgentMessages wiring", () => {
  const source = readFileSync(join(__dirname, "DashboardAgentMessages.tsx"), "utf8");

  it("stabilises the winners map and the stripped messages it renders", () => {
    expect(source).toContain("reuseWinners(previous.current, next)");
    expect(source).toContain("useInvestigationWinners(stripped)");
    expect(source).toContain("useMemo(() => messages.map(stripStepParts), [messages])");
    expect(source).toContain("strippedMessages.set(message, stripped)");
  });
});
