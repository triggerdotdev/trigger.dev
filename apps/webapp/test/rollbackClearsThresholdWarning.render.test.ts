import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RollbackClearsThresholdWarning } from "~/components/deployments/SkewProtectionThreshold";

function render(targetVersion: string, thresholdVersion?: string) {
  return renderToStaticMarkup(
    createElement(RollbackClearsThresholdWarning, { targetVersion, thresholdVersion })
  );
}

describe("RollbackClearsThresholdWarning", () => {
  // Catches: a rollback below the threshold clearing it with no warning in the dialog.
  it("warns when the rollback target is below the threshold", () => {
    const html = render("20261101.2", "20261105.1");
    expect(html).toContain("clears the skew protection threshold at 20261105.1");
    expect(html).toContain("Rolling back to 20261101.2");
  });

  // Catches: comparing versions as strings, where "20261105.10" sorts before "20261105.9".
  it("compares versions numerically, not as strings", () => {
    expect(render("20261105.9", "20261105.10")).toContain("clears the skew protection threshold");
    expect(render("20261105.10", "20261105.9")).toBe("");
  });

  it("shows nothing when the target is at the threshold", () => {
    expect(render("20261105.1", "20261105.1")).toBe("");
  });

  it("shows nothing when the target is above the threshold", () => {
    expect(render("20261106.1", "20261105.1")).toBe("");
  });

  // Catches: a task threshold the rollback clears missing from the warning, or one it keeps
  // being listed as cleared.
  it("lists each task threshold the rollback goes below, and no other", () => {
    const html = renderToStaticMarkup(
      createElement(RollbackClearsThresholdWarning, {
        targetVersion: "20261105.2",
        thresholdVersion: "20261105.1",
        taskThresholds: [
          { task: "support-agent", version: "20261105.10" },
          { task: "billing-agent", version: "20261105.2" },
        ],
      })
    );
    expect(html).toContain("support-agent");
    expect(html).toContain("20261105.10");
    expect(html).not.toContain("billing-agent");
    expect(html).not.toContain("Every task");
  });

  it("shows nothing when no threshold is set", () => {
    expect(render("20261101.2")).toBe("");
  });
});
