import { describe, expect, it, vi } from "vitest";
import { PostgresRunStore } from "@internal/run-store";
import { buildHydratorSelect, RunHydrator } from "~/services/realtime/runReader.server";

describe("buildHydratorSelect", () => {
  it("returns the full select when nothing is skipped", () => {
    const select = buildHydratorSelect([]);
    expect(select.id).toBe(true);
    expect(select.payload).toBe(true);
    expect(select.output).toBe(true);
    expect(select.metadata).toBe(true);
    expect(select.error).toBe(true);
  });

  it("keeps protocol-reserved columns even when asked to skip them", () => {
    // Reserved columns are always emitted by the serializer, so hydration must keep
    // them regardless of skipColumns or the output is null/incorrect.
    const select = buildHydratorSelect([
      "status",
      "taskIdentifier",
      "createdAt",
      "friendlyId",
      "payload",
    ]);
    expect(select.status).toBe(true);
    expect(select.taskIdentifier).toBe(true);
    expect(select.createdAt).toBe(true);
    expect(select.friendlyId).toBe(true);
    // A non-reserved skipped column is still dropped.
    expect(select.payload).toBeUndefined();
  });

  it("drops skipped columns but always keeps id + updatedAt", () => {
    const select = buildHydratorSelect(["payload", "output", "metadata", "error"]);
    expect(select.payload).toBeUndefined();
    expect(select.output).toBeUndefined();
    expect(select.metadata).toBeUndefined();
    expect(select.error).toBeUndefined();
    // Needed internally regardless of skipColumns (keys the row, drives the diff/offset).
    expect(select.id).toBe(true);
    expect(select.updatedAt).toBe(true);
    // A non-skipped column survives.
    expect(select.status).toBe(true);
  });
});

describe("RunHydrator.hydrateByIds column projection", () => {
  function makeHydrator() {
    let capturedSelect: Record<string, boolean> | undefined;
    const replica = {
      taskRun: {
        findMany: vi.fn(async ({ select }: { select: Record<string, boolean> }) => {
          capturedSelect = select;
          return [];
        }),
      },
    } as any;
    const runStore = new PostgresRunStore({ prisma: replica, readOnlyPrisma: replica });
    return { hydrator: new RunHydrator({ replica, runStore }), getSelect: () => capturedSelect };
  }

  it("projects the SELECT by skipColumns", async () => {
    const { hydrator, getSelect } = makeHydrator();
    await hydrator.hydrateByIds("env_1", ["run_1"], ["payload", "output"]);
    const select = getSelect()!;
    expect(select.payload).toBeUndefined();
    expect(select.output).toBeUndefined();
    expect(select.id).toBe(true);
    expect(select.updatedAt).toBe(true);
  });

  it("selects the full column set when no skipColumns are given", async () => {
    const { hydrator, getSelect } = makeHydrator();
    await hydrator.hydrateByIds("env_1", ["run_1"]);
    expect(getSelect()!.payload).toBe(true);
  });
});
