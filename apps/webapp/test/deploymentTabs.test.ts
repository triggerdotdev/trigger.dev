import { describe, expect, it } from "vitest";
import { deploymentTabs } from "~/components/deployments/deploymentTabs";

describe("deploymentTabs", () => {
  it("lists every tab and opens on Overview for a deployed version with build logs", () => {
    expect(deploymentTabs({ hasWorker: true, hasLogs: true })).toEqual([
      "overview",
      "tasks",
      "runs",
      "logs",
      "activity",
    ]);
  });

  // Catches: a Build logs tab on a deploy that has no log stream (every CLI-built deploy).
  it("leaves Build logs out when the deploy has no log stream", () => {
    expect(deploymentTabs({ hasWorker: true, hasLogs: false })).toEqual([
      "overview",
      "tasks",
      "runs",
      "activity",
    ]);
  });

  it("opens a deploy without a worker on its build logs", () => {
    expect(deploymentTabs({ hasWorker: false, hasLogs: true })[0]).toBe("logs");
  });

  // Catches: a failed CLI deploy opening on an empty Build logs tab, its error a click away.
  it("opens a deploy without a worker or build logs on Activity", () => {
    expect(deploymentTabs({ hasWorker: false, hasLogs: false })).toEqual([
      "activity",
      "overview",
      "tasks",
      "runs",
    ]);
  });
});
