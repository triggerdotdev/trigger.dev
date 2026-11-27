import { UnknownShardKey, type RunStore } from "@internal/run-store";
import { generateRunOpsId, generateRunOpsIdV2, RunId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, it, vi } from "vitest";
import type * as DbServer from "~/db.server";
import type * as RunStoreServer from "~/v3/runStore.server";
import type { ServiceValidationError } from "../../v3/services/baseService.server";
import { resolveBatchParentRun } from "./resolveBatchParentRun.server";

type BatchParentRunStore = Pick<RunStore, "findRun" | "findRunOnPrimary">;

// routesByShard: the run store is the routing store (both run-ops URLs set). splitReads: split reads
// are on. Each can be true without the other.
const H = vi.hoisted(() => ({ routesByShard: true, splitReads: true }));

vi.mock("~/db.server", async (importOriginal) => ({
  ...(await importOriginal<typeof DbServer>()),
  get runOpsSplitReadEnabled() {
    return H.splitReads;
  },
}));

vi.mock("~/v3/runStore.server", async (importOriginal) => ({
  ...(await importOriginal<typeof RunStoreServer>()),
  get runStoreRoutesByShard() {
    return H.routesByShard;
  },
}));

function createRunStore({ replicaRun, primaryRun }: { replicaRun?: object; primaryRun?: object }) {
  return {
    findRun: vi.fn().mockResolvedValue(replicaRun ?? null),
    findRunOnPrimary: vi.fn().mockResolvedValue(primaryRun ?? null),
  } as unknown as BatchParentRunStore;
}

describe("resolveBatchParentRun", () => {
  it("does not resolve an unused parent run", async () => {
    const runStore = createRunStore({});

    await expect(
      resolveBatchParentRun({
        runStore,
        environmentId: "env_1",
        parentRunId: "run_parent",
        resumeParentOnCompletion: false,
      })
    ).resolves.toBeUndefined();

    expect(runStore.findRun).not.toHaveBeenCalled();
  });

  it("returns a parent run from the calling environment", async () => {
    const runStore = createRunStore({ replicaRun: { id: "parent" } });

    await expect(
      resolveBatchParentRun({
        runStore,
        environmentId: "env_1",
        parentRunId: "run_parent",
        resumeParentOnCompletion: true,
      })
    ).resolves.toBe("parent");

    expect(runStore.findRun).toHaveBeenCalledWith(
      { id: "parent", runtimeEnvironmentId: "env_1" },
      { select: { id: true } }
    );
    expect(runStore.findRunOnPrimary).not.toHaveBeenCalled();
  });

  it("falls back to the owning primary", async () => {
    const runStore = createRunStore({ primaryRun: { id: "parent" } });

    await expect(
      resolveBatchParentRun({
        runStore,
        environmentId: "env_1",
        parentRunId: "run_parent",
        resumeParentOnCompletion: true,
      })
    ).resolves.toBe("parent");

    expect(runStore.findRunOnPrimary).toHaveBeenCalledWith(
      { id: "parent", runtimeEnvironmentId: "env_1" },
      { select: { id: true } }
    );
  });

  it("rejects a parent outside the calling environment", async () => {
    const runStore = createRunStore({});

    const result = resolveBatchParentRun({
      runStore,
      environmentId: "env_1",
      parentRunId: "run_foreign",
      resumeParentOnCompletion: true,
    });

    await expect(result).rejects.toMatchObject<ServiceValidationError>({
      message: "Parent run not found in the calling environment",
      status: 404,
    });
  });

  const memoryDbParent = () => RunId.toFriendlyId(generateRunOpsIdV2("m"));
  // A cuid's tail is not the marker: only the 26-character generation 2 shape names a shard.
  const cuidEndingInM2 = () => `${RunId.generate().friendlyId.slice(0, -2)}m2`;

  // Catches: a batch that does not wait taking a MemoryDB parent without looking it up, or blocking it.
  it("looks up a MemoryDB parent of a batch that does not wait, and gives no parent to block", async () => {
    const parentRunId = memoryDbParent();
    const runStore = createRunStore({ replicaRun: { id: "parent" } });

    await expect(
      resolveBatchParentRun({
        runStore,
        environmentId: "env_1",
        parentRunId,
        resumeParentOnCompletion: false,
      })
    ).resolves.toBeUndefined();

    expect(runStore.findRun).toHaveBeenCalledWith(
      { id: RunId.fromFriendlyId(parentRunId), runtimeEnvironmentId: "env_1" },
      { select: { id: true } }
    );
  });

  // Catches: a waiting batch of a found MemoryDB parent no longer blocking that parent.
  it("returns a found MemoryDB parent of a batch that waits", async () => {
    const runStore = createRunStore({ primaryRun: { id: "parent" } });

    await expect(
      resolveBatchParentRun({
        runStore,
        environmentId: "env_1",
        parentRunId: memoryDbParent(),
        resumeParentOnCompletion: true,
      })
    ).resolves.toBe("parent");
  });

  // Catches: a MemoryDB parent that is not found answering anything but the unknown-shard error.
  it("refuses a MemoryDB parent that is not found with the unknown-shard error, waiting or not", async () => {
    for (const resumeParentOnCompletion of [false, true]) {
      const runStore = createRunStore({});
      const result = resolveBatchParentRun({
        runStore,
        environmentId: "env_1",
        parentRunId: memoryDbParent(),
        resumeParentOnCompletion,
      });

      await expect(result).rejects.toBeInstanceOf(UnknownShardKey);
      await expect(result).rejects.toMatchObject({
        shardKey: "m",
        message: 'RoutingRunStore: no store is configured for shard key "m"',
      });
      expect(runStore.findRunOnPrimary).toHaveBeenCalled();
    }
  });

  // Catches: an install with one Postgres run store losing today's answers for a parent on `m`.
  it("with a single Postgres run store, treats a parent on m like any other parent", async () => {
    H.routesByShard = false;
    try {
      const runStore = createRunStore({});
      await expect(
        resolveBatchParentRun({
          runStore,
          environmentId: "env_1",
          parentRunId: memoryDbParent(),
          resumeParentOnCompletion: false,
        })
      ).resolves.toBeUndefined();
      expect(runStore.findRun).not.toHaveBeenCalled();

      await expect(
        resolveBatchParentRun({
          runStore,
          environmentId: "env_1",
          parentRunId: memoryDbParent(),
          resumeParentOnCompletion: true,
        })
      ).rejects.toMatchObject<ServiceValidationError>({
        message: "Parent run not found in the calling environment",
        status: 404,
      });
    } finally {
      H.routesByShard = true;
    }
  });

  // Catches: the routing store with split reads off skipping the look-up or the refusal for `m`.
  it("with the routing store and split reads off, still refuses a MemoryDB parent that is not found", async () => {
    H.splitReads = false;
    try {
      const runStore = createRunStore({});
      await expect(
        resolveBatchParentRun({
          runStore,
          environmentId: "env_1",
          parentRunId: memoryDbParent(),
          resumeParentOnCompletion: false,
        })
      ).rejects.toBeInstanceOf(UnknownShardKey);
      expect(runStore.findRun).toHaveBeenCalled();
    } finally {
      H.splitReads = true;
    }
  });

  // Catches: a look-up added for a parent of any other shape on a batch that does not wait.
  it("does not look up a cuid (one ending in m2), generation 1 or shard a parent of a batch that does not wait", async () => {
    for (const parentRunId of [
      RunId.generate().friendlyId,
      cuidEndingInM2(),
      RunId.toFriendlyId(generateRunOpsId()),
      RunId.toFriendlyId(generateRunOpsIdV2("a")),
    ]) {
      const runStore = createRunStore({ replicaRun: { id: "parent" } });

      await expect(
        resolveBatchParentRun({
          runStore,
          environmentId: "env_1",
          parentRunId,
          resumeParentOnCompletion: false,
        })
      ).resolves.toBeUndefined();

      expect(runStore.findRun).not.toHaveBeenCalled();
      expect(runStore.findRunOnPrimary).not.toHaveBeenCalled();
    }
  });

  // Catches: a missing parent of any other shape no longer answering the 404 when the batch waits.
  it("rejects a missing cuid (one ending in m2), generation 1 or shard a parent of a waiting batch with the 404", async () => {
    for (const parentRunId of [
      RunId.generate().friendlyId,
      cuidEndingInM2(),
      RunId.toFriendlyId(generateRunOpsId()),
      RunId.toFriendlyId(generateRunOpsIdV2("a")),
    ]) {
      const result = resolveBatchParentRun({
        runStore: createRunStore({}),
        environmentId: "env_1",
        parentRunId,
        resumeParentOnCompletion: true,
      });

      await expect(result).rejects.toMatchObject<ServiceValidationError>({
        message: "Parent run not found in the calling environment",
        status: 404,
      });
    }
  });
});
