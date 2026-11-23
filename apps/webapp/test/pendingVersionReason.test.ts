import { describe, expect, it } from "vitest";
import {
  describePendingVersion,
  type PendingVersionReasonInput,
} from "~/presenters/v3/pendingVersionReason";

const base: PendingVersionReasonInput = {
  statusReason: "TASK_NOT_IN_LATEST",
  taskIdentifier: "v2-only",
  queueName: "task/v2-only",
  currentVersion: "20261115.5",
  previousVersion: "20261115.4",
  lockedVersion: undefined,
  externalDeploymentId: undefined,
};

describe("describePendingVersion", () => {
  // Catches: the run panel showing only "Pending version" with no cause for a task dropped from the current deploy.
  it("names the task, the current version and the version that last had it", () => {
    expect(describePendingVersion(base)).toEqual({
      reason: "v2-only isn't in the current version 20261115.5. It was in 20261115.4.",
      releasedBy: "Starts when a deploy includes this task.",
    });
  });

  // Catches: telling a locked run a new deploy will release it, when it only ever runs on its locked version.
  it("points at the locked version for a locked run", () => {
    const result = describePendingVersion({ ...base, lockedVersion: "20261115.3" });
    expect(result.reason).toBe("v2-only isn't in version 20261115.3. It was in 20261115.4.");
    expect(result.releasedBy).toContain("locked to version 20261115.3");
  });

  // Catches: "isn't in the current version undefined" when nothing has been deployed.
  it("says there is no deployment when nothing is current", () => {
    expect(
      describePendingVersion({ ...base, statusReason: "NO_DEPLOYMENT", currentVersion: undefined })
        .reason
    ).toBe("No deployment in this environment yet.");
    expect(
      describePendingVersion({ ...base, currentVersion: undefined, previousVersion: undefined })
        .reason
    ).toBe("No deployment in this environment yet.");
  });

  // Catches: a missing queue described as a missing task.
  it("names the queue for QUEUE_NOT_FOUND", () => {
    expect(describePendingVersion({ ...base, statusReason: "QUEUE_NOT_FOUND" })).toEqual({
      reason: "Queue task/v2-only isn't in the current version 20261115.5.",
      releasedBy: "Starts when a deploy includes this queue.",
    });
  });

  it("names the external deployment it waits for", () => {
    expect(
      describePendingVersion({
        ...base,
        statusReason: "EXTERNAL_DEPLOYMENT_PENDING",
        externalDeploymentId: "dpl_123",
      }).reason
    ).toBe("Waiting for deployment dpl_123.");
  });

  // Catches: a crash or empty block for runs parked before statusReason existed.
  it("falls back to the generic text for an unknown reason", () => {
    expect(describePendingVersion({ ...base, statusReason: undefined }).reason).toBe(
      "Waiting for a version that includes this run's task and queue."
    );
  });
});
