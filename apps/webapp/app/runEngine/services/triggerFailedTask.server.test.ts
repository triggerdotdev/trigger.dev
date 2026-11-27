import { describe, expect, it, vi } from "vitest";
import type * as ResolveRunMintTargetModule from "~/v3/runOpsMigration/resolveRunMintTarget.server";

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
vi.mock("~/v3/runOpsMigration/resolveRunMintTarget.server", async (importOriginal) => {
  const actual = await importOriginal<typeof ResolveRunMintTargetModule>();
  return { ...actual, resolveRunMintTarget: vi.fn(actual.resolveRunMintTarget) };
});

import { classifyKind, generateRunOpsId, RunId } from "@trigger.dev/core/v3/isomorphic";
import { resolveRunMintTarget } from "~/v3/runOpsMigration/resolveRunMintTarget.server";
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

  // Catches: the born-terminal paths minting from other flags than the environment's (or any, without trace events).
  it("call passes the environment's flags to the mint, callWithoutTraceEvents passes none", async () => {
    const mint = vi.mocked(resolveRunMintTarget);
    mint.mockClear();
    const featureFlags = { runOpsMintKind: "runOpsId" };
    // Stop each call at the mint: both catch it and return null.
    mint.mockRejectedValueOnce(new Error("stop")).mockRejectedValueOnce(new Error("stop"));

    await expect(
      buildService().call({
        taskId: "task",
        environment: {
          id: "env_1",
          organizationId: "org_1",
          organization: { id: "org_1", featureFlags },
        } as any,
        payload: {},
        errorMessage: "failed",
      })
    ).resolves.toBeNull();
    await expect(
      buildService().callWithoutTraceEvents({
        environmentId: "env_1",
        environmentType: "PRODUCTION",
        projectId: "proj_1",
        organizationId: "org_1",
        taskId: "task",
        payload: {},
        errorMessage: "failed",
      })
    ).resolves.toBeNull();

    expect(mint.mock.calls.map(([args]) => args.environment)).toEqual([
      { organizationId: "org_1", id: "env_1", orgFeatureFlags: featureFlags },
      { organizationId: "org_1", id: "env_1", orgFeatureFlags: undefined },
    ]);
    expect(mint.mock.calls[0]![0].environment.orgFeatureFlags).toBe(featureFlags);
  });
});
