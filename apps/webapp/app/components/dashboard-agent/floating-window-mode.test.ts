// Guards the tree-shape invariant: DashboardAgent.tsx must mount FloatingAgentWindow
// exactly once, never branch it behind a mode check, and gate the right-column sizing
// on `mode === "rightPanel"` rather than swapping in a whole separate element tree.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = __dirname;

function read(file: string): string {
  return readFileSync(join(DIR, file), "utf8");
}

describe("DashboardAgent.tsx keeps one tree shape across display modes", () => {
  const source = read("DashboardAgent.tsx");

  it("mounts FloatingAgentWindow exactly once, unconditionally", () => {
    const occurrences = source.match(/<FloatingAgentWindow\b/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it("renders the open panel through FloatingAgentWindow", () => {
    expect(source).toContain("FloatingAgentWindow");
  });

  it('gates the right-column sizing on mode === "rightPanel", not a branch around FloatingAgentWindow', () => {
    expect(source).toContain('mode === "rightPanel" ? "380px" : "0px"');
  });

  it("unclips the degenerate panel with Tailwind v4's trailing-bang important modifier", () => {
    expect(source).toContain('"overflow-visible!"');
    expect(source).not.toContain('"!overflow-visible"');
  });
});
