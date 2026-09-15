import { describe, expect, it, vi } from "vitest";

// Empty singletons satisfy the module-level wiring imports; the mint method under test is driven
// directly via (service as any) and never touches the DB (same boundary as triggerTask.server.test.ts).
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  runOpsNewPrisma: {},
  runOpsLegacyPrisma: {},
  runOpsNewReplica: {},
  runOpsLegacyReplica: {},
}));
vi.mock("~/v3/runOpsMigration/splitMode.server", () => ({ isSplitEnabled: async () => false }));

import { classifyKind, generateRunOpsId, RunId } from "@trigger.dev/core/v3/isomorphic";
import { TriggerFailedTaskService } from "./triggerFailedTask.server";

function buildService() {
  return new TriggerFailedTaskService({ prisma: {} as any, engine: {} as any });
}

describe("TriggerFailedTaskService.mintFailedRunFriendlyId", () => {
  it("returns the caller-supplied runFriendlyId verbatim (override wins over any mint)", async () => {
    const override = RunId.toFriendlyId(generateRunOpsId());
    const minted = await (buildService() as any).mintFailedRunFriendlyId({
      organizationId: "org_1",
      environmentId: "env_1",
      runFriendlyId: override,
    });
    expect(minted).toBe(override);
  });

  it("without an override, still inherits a run-ops (NEW) parent by id-shape", async () => {
    const parentRunFriendlyId = RunId.toFriendlyId(generateRunOpsId());
    const minted = await (buildService() as any).mintFailedRunFriendlyId({
      organizationId: "org_1",
      environmentId: "env_1",
      parentRunFriendlyId,
    });
    expect(classifyKind(minted)).toBe("runOpsId");
  });
});
