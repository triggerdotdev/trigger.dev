import { describe, expect, it, vi } from "vitest";
import type * as ResolveRunMintTargetModule from "~/v3/runOpsMigration/resolveRunMintTarget.server";
import type * as RootResidencyModule from "~/v3/runOpsMigration/resolveRootResidency.server";

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
vi.mock("~/v3/runOpsMigration/resolveRootResidency.server", async (importOriginal) => {
  const actual = await importOriginal<typeof RootResidencyModule>();
  return {
    ...actual,
    rootResidency: {
      ...actual.rootResidency,
      allowsRootRun: vi.fn(actual.rootResidency.allowsRootRun),
    },
  };
});

import { MEMORYDB_SHARD_KEY, organizationContext } from "@internal/run-store";
import {
  classifyKind,
  generateRunOpsId,
  generateRunOpsIdV2,
  resolveShard,
  RunId,
} from "@trigger.dev/core/v3/isomorphic";
import { logger } from "~/services/logger.server";
import { rootResidency } from "~/v3/runOpsMigration/resolveRootResidency.server";
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

  const SIMPLE = { keyed: false, token: false, delayed: false, debounced: false };
  const environment = {
    id: "env_1",
    organizationId: "org_1",
    organization: { id: "org_1", featureFlags: { runResidencyEnabled: true } },
  };
  // Stops call right after the mint; its catch logs the minted id and returns null.
  function stoppedService() {
    return new TriggerFailedTaskService({
      prisma: {} as any,
      engine: {} as any,
      eventRepository: {
        get repository(): never {
          throw new Error("stop");
        },
      } as any,
    });
  }

  // Catches: the born-terminal root arm not asking the decision, or not marking the request born here.
  it("call mints a MemoryDB id for an admitted root and marks the scope born here", async () => {
    const decide = vi.mocked(rootResidency.allowsRootRun);
    const mint = vi.mocked(resolveRunMintTarget);
    decide.mockClear();
    mint.mockClear();
    decide.mockResolvedValueOnce(true);
    const error = vi.spyOn(logger, "error");
    const ctx = {};

    await organizationContext.run(ctx, () =>
      stoppedService().call({
        taskId: "task",
        environment: environment as any,
        payload: {},
        errorMessage: "failed",
      })
    );

    const minted = error.mock.calls.at(-1)?.[1]?.friendlyId as string;
    error.mockRestore();
    expect(minted).toMatch(/^run_[a-z0-9]{24}m2$/);
    expect(resolveShard(minted)).toBe(MEMORYDB_SHARD_KEY);
    expect(decide.mock.calls).toEqual([[environment.organization.featureFlags, SIMPLE]]);
    expect(decide.mock.calls[0]![0]).toBe(environment.organization.featureFlags);
    expect(mint).not.toHaveBeenCalled();
    expect(organizationContext.get()).toBeUndefined();
    expect(ctx).toEqual({ bornHere: true });
  });

  // Catches: a caller-supplied MemoryDB id (a batch item's) not marking the scope born here.
  it("call with a caller-supplied MemoryDB id marks the scope born here", async () => {
    const decide = vi.mocked(rootResidency.allowsRootRun);
    decide.mockClear();
    const supplied = RunId.toFriendlyId(generateRunOpsIdV2(MEMORYDB_SHARD_KEY));
    const ctx = {};
    await organizationContext.run(ctx, () =>
      stoppedService().call({
        taskId: "task",
        environment: { ...environment, organization: { id: "org_1", featureFlags: null } } as any,
        payload: {},
        errorMessage: "failed",
        runFriendlyId: supplied,
        batch: { id: "batch_1", index: 0 },
      })
    );
    expect(ctx).toEqual({ bornHere: true });
    expect(decide).not.toHaveBeenCalled();
  });

  // Catches: a batch item or a child failed run taking the root arm.
  it.each([
    ["batch", { batch: { id: "batch_1", index: 0 } }],
    ["parentRunId", { parentRunId: RunId.toFriendlyId(generateRunOpsId()) }],
  ])("call with %s set does not ask the decision", async (_name, extra) => {
    const decide = vi.mocked(rootResidency.allowsRootRun);
    decide.mockClear();
    await stoppedService().call({
      taskId: "task",
      environment: environment as any,
      payload: {},
      errorMessage: "failed",
      ...extra,
    });
    expect(decide).not.toHaveBeenCalled();
  });

  // Catches: callWithoutTraceEvents reading flags it does not have.
  it("callWithoutTraceEvents keeps today's mint and the real decision reads nothing", async () => {
    const decide = vi.mocked(rootResidency.allowsRootRun);
    const mint = vi.mocked(resolveRunMintTarget);
    decide.mockClear();
    mint.mockClear();
    mint.mockRejectedValueOnce(new Error("stop"));
    await buildService().callWithoutTraceEvents({
      environmentId: "env_1",
      environmentType: "PRODUCTION",
      projectId: "proj_1",
      organizationId: "org_1",
      taskId: "task",
      payload: {},
      errorMessage: "failed",
    });
    expect(mint.mock.calls.map(([args]) => args.environment.orgFeatureFlags)).toEqual([undefined]);
    expect(decide.mock.calls).toEqual([[undefined, SIMPLE]]);
    await expect(decide.mock.results[0]!.value).resolves.toBe(false);
  });
});
