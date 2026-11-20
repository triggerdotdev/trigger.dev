import { setTimeout } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  ExecutorToWorkerMessageCatalog,
  WorkerToExecutorMessageCatalog,
} from "../schemas/messages.js";
import { ZodIpcConnection } from "../zodIpc.js";
import { SharedRuntimeManager } from "./sharedRuntimeManager.js";

const ipc = new ZodIpcConnection({
  listenSchema: WorkerToExecutorMessageCatalog,
  emitSchema: ExecutorToWorkerMessageCatalog,
  process: {},
});

describe("SharedRuntimeManager", () => {
  it("rejects a second wait while one is pending", async () => {
    const manager = new SharedRuntimeManager(ipc, false);

    void manager.waitForWaitpoint({ waitpointFriendlyId: "waitpoint_a" });
    await setTimeout(10);

    await expect(
      manager.waitForWaitpoint({ waitpointFriendlyId: "waitpoint_b" })
    ).rejects.toMatchObject({ code: "TASK_DID_CONCURRENT_WAIT" });
  });

  it("allows a wait after reset even if the previous run left a wait pending", async () => {
    const manager = new SharedRuntimeManager(ipc, false);

    void manager.waitForWaitpoint({ waitpointFriendlyId: "waitpoint_a" });
    await setTimeout(10);

    manager.reset();

    const next = manager.waitForWaitpoint({ waitpointFriendlyId: "waitpoint_b" });
    await setTimeout(10);

    manager.resolveWaitpoints([
      {
        id: "waitpoint_b",
        friendlyId: "waitpoint_b",
        type: "MANUAL",
        completedAt: new Date(),
        outputIsError: false,
      },
    ]);

    await expect(next).resolves.toMatchObject({ ok: true });
  });
});
