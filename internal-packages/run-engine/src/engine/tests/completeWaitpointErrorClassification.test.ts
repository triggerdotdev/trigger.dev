// completeWaitpoint's store-selection guard must only turn a genuine id-classification
// failure into UnclassifiableWaitpointId. forWaitpointCompletion also probes the DB to
// resolve the owning store, so a transient database/infra error can surface from the same
// call — and those must bubble up UNCHANGED (keeping their original type, retryability, and
// error grouping) rather than being mislabelled as an unclassifiable id.
//
// This is a hermetic unit test: the error is thrown on the very first line of
// completeWaitpoint (runStore.forWaitpointCompletion), before any snapshot/enqueue work,
// so we can drive it with a minimal SystemResources and a fake runStore — no DB, no Redis.
import { UnclassifiableRunId } from "@trigger.dev/core/v3/isomorphic";
import { expect } from "vitest";
import { UnclassifiableWaitpointId } from "../errors.js";
import type { SystemResources } from "../systems/systems.js";
import { WaitpointSystem } from "../systems/waitpointSystem.js";

function createWaitpointSystem(forWaitpointCompletion: () => Promise<never>) {
  const runStore = { forWaitpointCompletion };

  const resources = {
    runStore,
    logger: {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as SystemResources;

  return new WaitpointSystem({
    resources,
    // Never reached on the store-resolution error path.
    executionSnapshotSystem: {} as any,
    enqueueSystem: {} as any,
  });
}

describe("completeWaitpoint store-resolution error classification", () => {
  it("rethrows a transient database error unchanged (never wraps it as UnclassifiableWaitpointId)", async () => {
    const dbError = new Error("Can't reach database server at db:5432");
    const waitpointSystem = createWaitpointSystem(() => Promise.reject(dbError));

    // The original error bubbles up as-is...
    await expect(waitpointSystem.completeWaitpoint({ id: "waitpoint_transient" })).rejects.toBe(
      dbError
    );
    // ...and is NOT relabelled as a classification failure.
    await expect(
      waitpointSystem.completeWaitpoint({ id: "waitpoint_transient" })
    ).rejects.not.toBeInstanceOf(UnclassifiableWaitpointId);
  });

  it("wraps a genuine UnclassifiableRunId as UnclassifiableWaitpointId with the original as cause", async () => {
    const waitpointId = "waitpoint_unclassifiable";
    const classificationError = new UnclassifiableRunId(waitpointId);
    const waitpointSystem = createWaitpointSystem(() => Promise.reject(classificationError));

    await expect(waitpointSystem.completeWaitpoint({ id: waitpointId })).rejects.toBeInstanceOf(
      UnclassifiableWaitpointId
    );

    const caught = (await waitpointSystem
      .completeWaitpoint({ id: waitpointId })
      .catch((error: unknown) => error)) as UnclassifiableWaitpointId;
    expect(caught).toBeInstanceOf(UnclassifiableWaitpointId);
    expect(caught.waitpointId).toBe(waitpointId);
    expect(caught.cause).toBe(classificationError);
  });
});
