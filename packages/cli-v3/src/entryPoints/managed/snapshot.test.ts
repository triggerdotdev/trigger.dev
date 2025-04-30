import { SnapshotManager } from "./snapshot.js";
import { ConsoleRunLogger } from "./logger.js";
import { RunExecutionData, TaskRunExecutionStatus, TaskRunStatus } from "@trigger.dev/core/v3";
import { setTimeout } from "timers/promises";

describe("SnapshotManager", () => {
  const mockLogger = new ConsoleRunLogger();
  const mockSnapshotHandler = vi.fn();
  const mockSuspendableHandler = vi.fn();

  let manager: SnapshotManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SnapshotManager({
      runFriendlyId: "test-run-1",
      initialSnapshotId: "snapshot-1",
      initialStatus: "PENDING_EXECUTING",
      logger: mockLogger,
      onSnapshotChange: mockSnapshotHandler,
      onSuspendable: mockSuspendableHandler,
    });
  });

  it("should initialize with correct initial values", () => {
    expect(manager.snapshotId).toBe("snapshot-1");
    expect(manager.status).toBe("PENDING_EXECUTING");
    expect(manager.suspendable).toBe(false);
  });

  it("should update snapshot when newer snapshot ID is provided", () => {
    manager.updateSnapshot("snapshot-2", "EXECUTING");
    expect(manager.snapshotId).toBe("snapshot-2");
    expect(manager.status).toBe("EXECUTING");
  });

  it("should not update snapshot when older snapshot ID is provided", () => {
    manager.updateSnapshot("snapshot-2", "EXECUTING");
    manager.updateSnapshot("snapshot-1", "FINISHED");
    expect(manager.snapshotId).toBe("snapshot-2");
    expect(manager.status).toBe("EXECUTING");
  });

  it("should handle suspendable state changes", async () => {
    await manager.setSuspendable(true);
    expect(manager.suspendable).toBe(true);
    expect(mockSuspendableHandler).not.toHaveBeenCalled();

    // When status changes to EXECUTING_WITH_WAITPOINTS, suspendable handler should be called
    await manager.handleSnapshotChange(
      createRunExecutionData({
        snapshotId: "snapshot-2",
        executionStatus: "EXECUTING_WITH_WAITPOINTS",
      })
    );

    expect(mockSuspendableHandler).toHaveBeenCalledWith({
      id: "snapshot-2",
      status: "EXECUTING_WITH_WAITPOINTS",
    });

    // Reset mocks
    vi.clearAllMocks();

    // Test this the other way around
    await manager.setSuspendable(false);
    expect(manager.suspendable).toBe(false);
    expect(mockSuspendableHandler).not.toHaveBeenCalled();

    // We should still be EXECUTING_WITH_WAITPOINTS
    expect(manager.status).toBe("EXECUTING_WITH_WAITPOINTS");

    // When we're suspendable again, the handler should be called
    await manager.setSuspendable(true);
    expect(manager.suspendable).toBe(true);
    expect(mockSuspendableHandler).toHaveBeenCalledWith({
      id: "snapshot-2",
      status: "EXECUTING_WITH_WAITPOINTS",
    });

    // Reset mocks
    vi.clearAllMocks();

    // Check simple toggle
    await manager.setSuspendable(false);
    expect(manager.suspendable).toBe(false);
    await manager.setSuspendable(true);
    expect(manager.suspendable).toBe(true);
    expect(mockSuspendableHandler).toHaveBeenCalledWith({
      id: "snapshot-2",
      status: "EXECUTING_WITH_WAITPOINTS",
    });

    // Reset mocks
    vi.clearAllMocks();

    // This should also work with QUEUED_EXECUTING
    await manager.setSuspendable(false);
    expect(manager.suspendable).toBe(false);

    // Update the snapshot to QUEUED_EXECUTING
    await manager.handleSnapshotChange(
      createRunExecutionData({
        snapshotId: "snapshot-3",
        executionStatus: "QUEUED_EXECUTING",
      })
    );
    expect(mockSuspendableHandler).not.toHaveBeenCalled();

    // Set suspendable to true and check that the handler is called
    await manager.setSuspendable(true);
    expect(manager.suspendable).toBe(true);
    expect(mockSuspendableHandler).toHaveBeenCalledWith({
      id: "snapshot-3",
      status: "QUEUED_EXECUTING",
    });
  });

  it("should process queue in correct order with suspendable changes at the back", async () => {
    const executionOrder: string[] = [];

    // Create a manager with handlers that track execution order
    const manager = new SnapshotManager({
      runFriendlyId: "test-run-1",
      initialSnapshotId: "snapshot-1",
      initialStatus: "PENDING_EXECUTING",
      logger: mockLogger,
      onSnapshotChange: async (data) => {
        executionOrder.push(`snapshot:${data.snapshot.friendlyId}`);
        await setTimeout(10); // Small delay
      },
      onSuspendable: async (state) => {
        executionOrder.push(`suspendable:${state.id}`);
        await setTimeout(10); // Small delay
      },
    });

    const promises = [
      manager.setSuspendable(false),
      manager.handleSnapshotChange(createRunExecutionData({ snapshotId: "snapshot-2" })),
      manager.setSuspendable(true),
      manager.handleSnapshotChange(
        createRunExecutionData({
          snapshotId: "snapshot-3",
          executionStatus: "EXECUTING_WITH_WAITPOINTS",
        })
      ),
    ];

    await Promise.all(promises);

    // Verify execution order:
    // 1. Snapshots should be processed in order (2 then 3)
    // 2. Suspendable changes should be at the end
    expect(executionOrder).toEqual([
      "snapshot:snapshot-2",
      "snapshot:snapshot-3",
      "suspendable:snapshot-3",
    ]);
  });

  it("should skip older snapshots", async () => {
    const executionOrder: string[] = [];

    const manager = new SnapshotManager({
      runFriendlyId: "test-run-1",
      initialSnapshotId: "snapshot-1",
      initialStatus: "PENDING_EXECUTING",
      logger: mockLogger,
      onSnapshotChange: async (data) => {
        executionOrder.push(`snapshot:${data.snapshot.friendlyId}`);
      },
      onSuspendable: async () => {},
    });

    // Queue snapshots in reverse order
    const promises = [
      manager.handleSnapshotChange(createRunExecutionData({ snapshotId: "snapshot-3" })),
      manager.handleSnapshotChange(createRunExecutionData({ snapshotId: "snapshot-2" })),
      manager.handleSnapshotChange(createRunExecutionData({ snapshotId: "snapshot-1" })),
    ];

    await Promise.all(promises);

    // Should be processed in ID order
    expect(executionOrder).toEqual(["snapshot:snapshot-3"]);
  });

  it("should skip duplicate snapshots", async () => {
    const executionOrder: string[] = [];

    const manager = new SnapshotManager({
      runFriendlyId: "test-run-1",
      initialSnapshotId: "snapshot-1",
      initialStatus: "PENDING_EXECUTING",
      logger: mockLogger,
      onSnapshotChange: async (data) => {
        executionOrder.push(`snapshot:${data.snapshot.friendlyId}`);
      },
      onSuspendable: async () => {},
    });

    // Queue snapshots in reverse order
    const promises = [
      manager.handleSnapshotChange(createRunExecutionData({ snapshotId: "snapshot-2" })),
      manager.handleSnapshotChange(createRunExecutionData({ snapshotId: "snapshot-2" })),
      manager.handleSnapshotChange(createRunExecutionData({ snapshotId: "snapshot-2" })),
    ];

    await Promise.all(promises);

    // Should be processed in ID order
    expect(executionOrder).toEqual(["snapshot:snapshot-2"]);
  });

  it("should prevent concurrent handler execution", async () => {
    const executionTimes: { start: number; end: number; type: string }[] = [];
    let currentlyExecuting = false;

    const manager = new SnapshotManager({
      runFriendlyId: "test-run-1",
      initialSnapshotId: "snapshot-1",
      initialStatus: "PENDING_EXECUTING",
      logger: mockLogger,
      onSnapshotChange: async (data) => {
        if (currentlyExecuting) {
          throw new Error("Handler executed while another handler was running");
        }
        currentlyExecuting = true;
        const start = Date.now();
        await setTimeout(20); // Deliberate delay to increase chance of catching concurrent execution
        const end = Date.now();
        executionTimes.push({ start, end, type: `snapshot:${data.snapshot.friendlyId}` });
        currentlyExecuting = false;
      },
      onSuspendable: async (state) => {
        if (currentlyExecuting) {
          throw new Error("Handler executed while another handler was running");
        }
        currentlyExecuting = true;
        const start = Date.now();
        await setTimeout(20); // Deliberate delay
        const end = Date.now();
        executionTimes.push({ start, end, type: `suspendable:${state.id}` });
        currentlyExecuting = false;
      },
    });

    // Create a mix of rapid changes
    const promises = [
      manager.setSuspendable(true),
      manager.handleSnapshotChange(createRunExecutionData({ snapshotId: "snapshot-2" })),
      manager.setSuspendable(false),
      manager.handleSnapshotChange(createRunExecutionData({ snapshotId: "snapshot-3" })),
      manager.setSuspendable(true),
      manager.setSuspendable(true),
      manager.setSuspendable(false),
      manager.setSuspendable(false),
      manager.handleSnapshotChange(createRunExecutionData({ snapshotId: "snapshot-4" })),
      manager.setSuspendable(false),
      manager.setSuspendable(true),
      manager.handleSnapshotChange(createRunExecutionData({ snapshotId: "snapshot-1" })),
      manager.setSuspendable(false),
      manager.handleSnapshotChange(createRunExecutionData({ snapshotId: "snapshot-3" })),
      manager.setSuspendable(true),
      manager.setSuspendable(true),
      manager.setSuspendable(false),
      manager.handleSnapshotChange(createRunExecutionData({ snapshotId: "snapshot-2" })),
      manager.setSuspendable(false),
    ];

    await Promise.all(promises);

    // Verify no overlapping execution times
    for (let i = 1; i < executionTimes.length; i++) {
      const previous = executionTimes[i - 1]!;
      const current = executionTimes[i]!;
      expect(current.start).toBeGreaterThanOrEqual(previous.end);
    }
  });

  it("should handle cleanup and error scenarios", async () => {
    const executionOrder: string[] = [];
    let shouldThrowSnapshotError = false;
    let shouldThrowSuspendableError = false;

    const manager = new SnapshotManager({
      runFriendlyId: "test-run-1",
      initialSnapshotId: "snapshot-1",
      initialStatus: "PENDING_EXECUTING",
      logger: mockLogger,
      onSnapshotChange: async (data) => {
        if (shouldThrowSnapshotError) {
          throw new Error("Snapshot handler error");
        }
        executionOrder.push(`snapshot:${data.snapshot.friendlyId}`);
        await setTimeout(10);
      },
      onSuspendable: async (state) => {
        if (shouldThrowSuspendableError) {
          throw new Error("Suspendable handler error");
        }
        executionOrder.push(`suspendable:${state.id}`);
        await setTimeout(10);
      },
    });

    // Queue up some changes
    const initialPromises = [
      manager.handleSnapshotChange(createRunExecutionData({ snapshotId: "snapshot-2" })),
      manager.setSuspendable(true),
      manager.handleSnapshotChange(createRunExecutionData({ snapshotId: "snapshot-3" })),
    ];

    expect(manager.queueLength).not.toBe(0);

    // Call cleanup before they complete
    manager.cleanup();

    expect(manager.queueLength).toBe(0);

    // These should complete without executing handlers
    const results = await Promise.allSettled(initialPromises);

    // Only the first snapshot should have been processed
    expect(executionOrder).toEqual(["snapshot:snapshot-2"]);

    // The last two promises should have been rejected
    expect(results).toMatchObject([
      { status: "fulfilled" },
      { status: "rejected" },
      { status: "rejected" },
    ]);

    // Now test error handling
    shouldThrowSnapshotError = true;
    await expect(
      manager.handleSnapshotChange(createRunExecutionData({ snapshotId: "snapshot-4" }))
    ).rejects.toThrow("Snapshot handler error");

    // Queue should continue processing after error
    shouldThrowSnapshotError = false;
    await manager.handleSnapshotChange(
      createRunExecutionData({
        snapshotId: "snapshot-5",
        executionStatus: "EXECUTING_WITH_WAITPOINTS",
      })
    );
    expect(executionOrder).toEqual(["snapshot:snapshot-2", "snapshot:snapshot-5"]);

    // Test suspendable error
    shouldThrowSuspendableError = true;
    await expect(manager.setSuspendable(true)).rejects.toThrow("Suspendable handler error");

    // Queue should continue processing after suspendable error
    shouldThrowSuspendableError = false;

    // Toggle suspendable state to trigger handler
    await manager.setSuspendable(false);
    await manager.setSuspendable(true);

    expect(executionOrder).toEqual([
      "snapshot:snapshot-2",
      "snapshot:snapshot-5",
      "suspendable:snapshot-5",
    ]);
  });

  it("should handle edge cases and high concurrency", async () => {
    const executionOrder: string[] = [];
    const executionTimes: { start: number; end: number; type: string }[] = [];
    let currentlyExecuting = false;
    let handlerExecutionCount = 0;

    const manager = new SnapshotManager({
      runFriendlyId: "test-run-1",
      initialSnapshotId: "snapshot-1",
      initialStatus: "PENDING_EXECUTING",
      logger: mockLogger,
      onSnapshotChange: async (data) => {
        if (currentlyExecuting) {
          throw new Error("Handler executed while another handler was running");
        }
        currentlyExecuting = true;
        handlerExecutionCount++;

        const start = Date.now();
        executionOrder.push(`snapshot:${data.snapshot.friendlyId}`);
        await setTimeout(Math.random() * 20); // Random delay to increase race condition chances
        const end = Date.now();

        executionTimes.push({ start, end, type: `snapshot:${data.snapshot.friendlyId}` });
        currentlyExecuting = false;
      },
      onSuspendable: async (state) => {
        if (currentlyExecuting) {
          throw new Error("Handler executed while another handler was running");
        }
        currentlyExecuting = true;
        handlerExecutionCount++;

        const start = Date.now();
        executionOrder.push(`suspendable:${state.id}`);
        await setTimeout(Math.random() * 20); // Random delay
        const end = Date.now();

        executionTimes.push({ start, end, type: `suspendable:${state.id}` });
        currentlyExecuting = false;
      },
    });

    // Test empty snapshot IDs
    await manager.handleSnapshotChange(createRunExecutionData({ snapshotId: "" }));
    expect(executionOrder).toEqual([]);

    // Create a very long queue of mixed changes
    const promises: Promise<void>[] = [];

    // Add 50 mixed changes
    for (let i = 1; i <= 50; i++) {
      if (i % 2 === 0) {
        promises.push(
          manager.handleSnapshotChange(createRunExecutionData({ snapshotId: `snapshot-${i}` }))
        );
      } else {
        promises.push(manager.setSuspendable(i % 4 === 1));
      }
    }

    // Add rapid toggling of suspendable state
    for (let i = 0; i < 20; i++) {
      promises.push(manager.setSuspendable(i % 2 === 0));
    }

    // Add overlapping snapshot changes
    const snapshotIds = ["A", "B", "C", "D", "E"];
    for (const id of snapshotIds) {
      for (let i = 0; i < 5; i++) {
        promises.push(
          manager.handleSnapshotChange(
            createRunExecutionData({ snapshotId: `snapshot-${id}-${i}` })
          )
        );
      }
    }

    console.log(manager.queueLength);

    await Promise.all(promises);

    // Verify handler execution exclusivity
    for (let i = 1; i < executionTimes.length; i++) {
      const previous = executionTimes[i - 1]!;
      const current = executionTimes[i]!;
      expect(current.start).toBeGreaterThanOrEqual(previous.end);
    }

    // Verify all handlers executed in sequence
    expect(currentlyExecuting).toBe(false);

    // Verify suspendable state is correctly maintained
    const finalSuspendableState = manager.suspendable;
    const lastSuspendableChange = executionOrder
      .filter((entry) => entry.startsWith("suspendable:"))
      .pop();

    // The last recorded suspendable change should match the final state
    if (finalSuspendableState) {
      expect(lastSuspendableChange).toBeDefined();
    }

    // Verify snapshot ordering
    const snapshotExecutions = executionOrder
      .filter((entry) => entry.startsWith("snapshot:"))
      .map((entry) => entry.split(":")[1]);

    // Each snapshot should be greater than the previous one
    for (let i = 1; i < snapshotExecutions.length; i++) {
      expect(snapshotExecutions[i]! > snapshotExecutions[i - 1]!).toBe(true);
    }
  });

  it("should handle queue processing and remaining edge cases", async () => {
    const executionOrder: string[] = [];
    let processingCount = 0;

    const manager = new SnapshotManager({
      runFriendlyId: "test-run-1",
      initialSnapshotId: "snapshot-1",
      initialStatus: "PENDING_EXECUTING",
      logger: mockLogger,
      onSnapshotChange: async (data) => {
        processingCount++;
        executionOrder.push(`snapshot:${data.snapshot.friendlyId}`);
        await setTimeout(10);
        processingCount--;
      },
      onSuspendable: async (state) => {
        processingCount++;
        executionOrder.push(`suspendable:${state.id}`);
        await setTimeout(10);
        processingCount--;
      },
    });

    // Test parallel queue processing prevention
    const parallelPromises = Array.from({ length: 5 }, (_, i) =>
      manager.handleSnapshotChange(
        createRunExecutionData({
          snapshotId: `parallel-${i}`,
          executionStatus: "EXECUTING",
        })
      )
    );

    // Add some suspendable changes in the middle
    parallelPromises.push(manager.setSuspendable(true));
    parallelPromises.push(manager.setSuspendable(false));

    // Add more snapshot changes
    parallelPromises.push(
      ...Array.from({ length: 5 }, (_, i) =>
        manager.handleSnapshotChange(
          createRunExecutionData({
            snapshotId: `parallel-${i + 5}`,
            executionStatus: "EXECUTING",
          })
        )
      )
    );

    await Promise.all(parallelPromises);

    // Verify processingCount never exceeded 1
    expect(processingCount).toBe(0);

    // Test edge case: snapshot ID comparison with special characters
    const specialCharPromises = [
      manager.handleSnapshotChange(
        createRunExecutionData({
          snapshotId: "snapshot-1!",
          executionStatus: "EXECUTING",
        })
      ),
      manager.handleSnapshotChange(
        createRunExecutionData({
          snapshotId: "snapshot-1@",
          executionStatus: "EXECUTING",
        })
      ),
      manager.handleSnapshotChange(
        createRunExecutionData({
          snapshotId: "snapshot-1#",
          executionStatus: "EXECUTING",
        })
      ),
    ];

    await Promise.all(specialCharPromises);

    // Test edge case: very long snapshot IDs
    const longIdPromises = [
      manager.handleSnapshotChange(
        createRunExecutionData({
          snapshotId: "a".repeat(1000),
          executionStatus: "EXECUTING",
        })
      ),
      manager.handleSnapshotChange(
        createRunExecutionData({
          snapshotId: "b".repeat(1000),
          executionStatus: "EXECUTING",
        })
      ),
    ];

    await Promise.all(longIdPromises);

    // Test edge case: rapid queue changes during processing
    let isProcessing = false;
    const rapidChangeManager = new SnapshotManager({
      runFriendlyId: "test-run-2",
      initialSnapshotId: "snapshot-1",
      initialStatus: "PENDING_EXECUTING",
      logger: mockLogger,
      onSnapshotChange: async (data) => {
        if (isProcessing) {
          throw new Error("Parallel processing detected");
        }
        isProcessing = true;
        await setTimeout(50); // Longer delay to test queue changes during processing
        executionOrder.push(`rapid:${data.snapshot.friendlyId}`);
        isProcessing = false;
      },
      onSuspendable: async () => {},
    });

    // Start processing a snapshot
    const initialPromise = rapidChangeManager.handleSnapshotChange(
      createRunExecutionData({
        runId: "test-run-2",
        snapshotId: "snapshot-2",
        executionStatus: "EXECUTING",
      })
    );

    // Queue more changes while the first one is processing
    await setTimeout(10);
    const queuePromises = [
      rapidChangeManager.handleSnapshotChange(
        createRunExecutionData({
          runId: "test-run-2",
          snapshotId: "snapshot-3",
          executionStatus: "EXECUTING",
        })
      ),
      rapidChangeManager.handleSnapshotChange(
        createRunExecutionData({
          runId: "test-run-2",
          snapshotId: "snapshot-4",
          executionStatus: "EXECUTING",
        })
      ),
    ];

    await Promise.all([initialPromise, ...queuePromises]);

    // Verify the rapid changes were processed in order
    const rapidChanges = executionOrder.filter((entry) => entry.startsWith("rapid:"));
    expect(rapidChanges).toEqual(["rapid:snapshot-2", "rapid:snapshot-3", "rapid:snapshot-4"]);
  });
});

// Helper to generate RunExecutionData with sensible defaults
function createRunExecutionData(
  overrides: {
    runId?: string;
    runFriendlyId?: string;
    snapshotId?: string;
    snapshotFriendlyId?: string;
    executionStatus?: TaskRunExecutionStatus;
    description?: string;
  } = {}
): RunExecutionData {
  const runId = overrides.runId ?? "test-run-1";
  const runFriendlyId = overrides.runFriendlyId ?? runId;
  const snapshotId = overrides.snapshotId ?? "snapshot-1";
  const snapshotFriendlyId = overrides.snapshotFriendlyId ?? snapshotId;

  return {
    version: "1" as const,
    run: {
      id: runId,
      friendlyId: runFriendlyId,
      status: "EXECUTING",
      attemptNumber: 1,
    },
    snapshot: {
      id: snapshotId,
      friendlyId: snapshotFriendlyId,
      executionStatus: overrides.executionStatus ?? "EXECUTING",
      description: overrides.description ?? "Test snapshot",
    },
    completedWaitpoints: [],
  };
}
