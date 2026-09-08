import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composerEscapeAction } from "./composer-escape";

const COMPOSER = readFileSync(join(__dirname, "DashboardAgentComposer.tsx"), "utf8");

describe("Escape while the composer has focus", () => {
  it("is kept by the composer on the first Escape with a draft, so the panel stays open", () => {
    expect(composerEscapeAction("half a question about a failing run", true)).toBe("swallow");
  });

  it("lets a second consecutive Escape through, so the panel closes", () => {
    expect(composerEscapeAction("half a question about a failing run", false)).toBe("pass");
  });

  it("guards the draft again once the guard is re-armed by typing", () => {
    expect(composerEscapeAction("half a question, now longer", true)).toBe("swallow");
  });

  it("closes the panel on the first Escape when there is nothing to lose", () => {
    expect(composerEscapeAction("", true)).toBe("pass");
  });

  it("reads whitespace as nothing to lose, matching what Send accepts", () => {
    expect(composerEscapeAction("  \n ", true)).toBe("pass");
  });
});

// Source-level checks: the guard's step is spent in the composer, not in the pure helper.
describe("the composer's Escape wiring", () => {
  it("disarms the guard in the swallow branch, so the next Escape passes", () => {
    expect(COMPOSER).toMatch(
      /=== "swallow"\s*\)\s*\{\s*e\.preventDefault\(\);\s*escapeGuardArmed\.current = false;/
    );
  });

  it("swallows an IME-cancelling Escape without spending the guard's step", () => {
    expect(COMPOSER).toMatch(
      /e\.key === "Escape" && e\.nativeEvent\.isComposing\s*\)\s*\{\s*e\.preventDefault\(\);\s*return;/
    );
  });
});

// Source-level checks: the composer's own layout, which no pure helper can answer for.
describe("the composer's context row and text box", () => {
  it("renders the context once, below the text box, in either layout", () => {
    const sites = [...COMPOSER.matchAll(/\{context \?\? <span \/>\}/g)];
    // Two source sites, one per layout: the `isHero` branches are exclusive, so a
    // rendered composer shows the context exactly once.
    expect(sites).toHaveLength(2);
    for (const site of sites) {
      expect(site.index).toBeGreaterThan(COMPOSER.indexOf("<textarea"));
    }
  });

  it("gives the text box a 1.5 line height, so a growing draft stays legible", () => {
    const textarea = COMPOSER.slice(COMPOSER.indexOf("<textarea"));
    expect(textarea.slice(0, textarea.indexOf("/>"))).toContain("leading-[1.5]");
  });
});
