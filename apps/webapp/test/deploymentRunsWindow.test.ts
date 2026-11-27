import { describe, expect, it } from "vitest";
import { deploymentRunsWindow } from "~/v3/utils/deploymentRunsWindow";

const DAY_MS = 24 * 60 * 60 * 1000;
const deployedAt = new Date("2026-03-10T12:00:00Z");

describe("deploymentRunsWindow", () => {
  // Catches: an old version's runs list reading every run in the environment since its deploy.
  it("ends a day after the next deploy", () => {
    const nextDeployedAt = new Date("2026-03-12T09:00:00Z");
    expect(
      deploymentRunsWindow({ startedAt: deployedAt, nextDeployedAt, isCurrent: false })
    ).toEqual({ from: deployedAt.getTime() - DAY_MS, to: nextDeployedAt.getTime() + DAY_MS });
  });

  it("has no end for the newest version", () => {
    expect(
      deploymentRunsWindow({ startedAt: deployedAt, nextDeployedAt: null, isCurrent: false })
    ).toEqual({ from: deployedAt.getTime() - DAY_MS });
  });

  // Catches: a rolled-back-to version losing the runs it has taken since the rollback.
  it("has no end for the current version, even with a later deploy", () => {
    expect(
      deploymentRunsWindow({
        startedAt: deployedAt,
        nextDeployedAt: new Date("2026-03-12T09:00:00Z"),
        isCurrent: true,
      })
    ).toEqual({ from: deployedAt.getTime() - DAY_MS });
  });

  it("never ends before the version's own deploy", () => {
    const window = deploymentRunsWindow({
      startedAt: deployedAt,
      nextDeployedAt: new Date("2026-03-10T11:00:00Z"),
      isCurrent: false,
    });
    expect(window.to).toBe(deployedAt.getTime() + DAY_MS);
  });
});
