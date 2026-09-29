import type { RunStore } from "@internal/run-store";
import { describe, expect, it, vi } from "vitest";
import type { ServiceValidationError } from "../../v3/services/baseService.server";
import { resolveBatchParentRun } from "./resolveBatchParentRun.server";

type BatchParentRunStore = Pick<RunStore, "findRun" | "findRunOnPrimary">;

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
});
