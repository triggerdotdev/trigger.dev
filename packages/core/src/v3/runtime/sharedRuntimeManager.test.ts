import { setTimeout } from "node:timers/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";
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

  it("logs waitpoint identifiers but not the waitpoint output or idempotency key", async () => {
    const manager = new SharedRuntimeManager(ipc, false);
    const send = vi.spyOn(ipc, "send").mockResolvedValue(undefined);
    onTestFinished(() => send.mockRestore());

    manager.resolveWaitpoints([
      {
        id: "waitpoint_c",
        friendlyId: "waitpoint_c",
        type: "MANUAL",
        completedAt: new Date(),
        outputIsError: false,
        idempotencyKey: "idempotency-value-6c3f",
        output: JSON.stringify({ result: "output-value-4e7a" }),
        outputType: "application/json",
      },
    ]);
    await setTimeout(10);

    const debugLogs = send.mock.calls.filter(([type]) => type === "SEND_DEBUG_LOG");
    expect(debugLogs).toContainEqual([
      "SEND_DEBUG_LOG",
      expect.objectContaining({
        message: "no resolver found for resolverId",
        properties: expect.objectContaining({
          waitpoint: expect.objectContaining({ id: "waitpoint_c", type: "MANUAL" }),
        }),
      }),
    ]);
    expect(JSON.stringify(debugLogs)).not.toContain("output-value-4e7a");
    expect(JSON.stringify(debugLogs)).not.toContain("idempotency-value-6c3f");
  });
});
