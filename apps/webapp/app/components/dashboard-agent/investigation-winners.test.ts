import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reuseWinners, sameOccurrences } from "./investigation-winners";

const source = readFileSync(new URL("./DashboardAgentMessages.tsx", import.meta.url), "utf8");

function recompute(entries: Array<[string, string]>): Map<string, string> {
  return new Map(entries.map(([id, occurrence]) => [id, occurrence]));
}

describe("investigation winners identity", () => {
  it("reuses the previous map when the winners are unchanged", () => {
    const first = recompute([["inv_1", "m1:0"]]);
    const second = recompute([["inv_1", "m1:0"]]);
    expect(second).not.toBe(first);

    expect(reuseWinners(first, second)).toBe(first);
  });

  it("takes the new map when a winner moves to another occurrence", () => {
    const first = recompute([["inv_1", "m1:0"]]);
    const moved = recompute([["inv_1", "m2:0"]]);

    expect(reuseWinners(first, moved)).toBe(moved);
  });

  it("takes the new map when an investigation appears", () => {
    const first = recompute([["inv_1", "m1:0"]]);
    const grown = recompute([
      ["inv_1", "m1:0"],
      ["inv_2", "m2:0"],
    ]);

    expect(reuseWinners(first, grown)).toBe(grown);
    expect(sameOccurrences(first, grown)).toBe(false);
  });

  it("has no previous map on the first render", () => {
    const only = recompute([["inv_1", "m1:0"]]);
    expect(reuseWinners(undefined, only)).toBe(only);
  });

  it("computes the winners inside a memo and reuses the reference", () => {
    expect(source).toMatch(/useMemo\(\(\) => winningInvestigationOccurrences\(messages\)/);
    expect(source).toContain("reuseWinners(previous.current, next)");
    expect(source).toContain("useInvestigationWinners(stripped)");
    expect(source).not.toMatch(/=\s*winningInvestigationOccurrences\(stripped\)/);
  });
});
