import { describe, expect, it, vi } from "vitest";
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
    return { hydrator: new RunHydrator({ replica }), getSelect: () => capturedSelect };
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
