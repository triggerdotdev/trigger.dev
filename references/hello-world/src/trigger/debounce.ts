import { logger, task, wait } from "@trigger.dev/sdk/v3";

/**
 * A simple task that processes data updates.
 * This is the task we'll debounce to demonstrate the feature.
 */
export const processDataUpdate = task({
  id: "process-data-update",
  run: async (payload: { userId: string; data: Record<string, unknown> }) => {
    logger.info("Processing data update", { payload });

    // Simulate some processing work
    await wait.for({ seconds: 1 });

    logger.info("Data update processed successfully", { userId: payload.userId });

    return {
      processed: true,
      userId: payload.userId,
      timestamp: new Date().toISOString(),
    };
  },
});

/**
 * Example 1: Basic Debounce
 *
 * This demonstrates how debounce works with rapid triggers.
 * When triggered multiple times with the same key within the delay period,
 * only one run will execute (with the first payload).
 *
 * Trigger this task multiple times rapidly with the same debounceKey to see
 * how only one run is created.
 */
export const basicDebounceExample = task({
  id: "basic-debounce-example",
  run: async (payload: { value: string; debounceKey: string }) => {
    logger.info("Starting basic debounce example", { payload });

    // Trigger processDataUpdate with debounce
    // If this task is triggered multiple times within 5 seconds with the same
    // debounceKey, only one processDataUpdate run will be created
    const handle = await processDataUpdate.trigger(
      {
        userId: payload.debounceKey,
        data: { value: payload.value, triggeredAt: new Date().toISOString() },
      },
      {
        debounce: {
          key: payload.debounceKey,
          delay: "5s",
        },
      }
    );

    logger.info("Triggered processDataUpdate with debounce", {
      runId: handle.id,
      debounceKey: payload.debounceKey,
    });

    return { triggeredRunId: handle.id };
  },
});

/**
 * Demonstration: Rapid Debounce Triggering
 *
 * This task demonstrates debounce in action by triggering processDataUpdate
 * multiple times rapidly with the same debounce key. Despite 5 triggers,
 * only ONE processDataUpdate run will be created.
 *
 * Run this task and watch the logs - you'll see:
 * - 5 "Triggering attempt" logs
 * - All 5 return the SAME run ID
 * - Only 1 processDataUpdate run actually executes
 */
export const demonstrateDebounce = task({
  id: "demonstrate-debounce",
  run: async (payload: { debounceKey?: string }) => {
    const key = payload.debounceKey ?? "demo-key";

    logger.info("Starting debounce demonstration", { debounceKey: key });
    logger.info("Will trigger processDataUpdate 5 times rapidly with the same debounce key");

    const handles: string[] = [];

    // Trigger 5 times rapidly - all should return the same run
    for (let i = 1; i <= 5; i++) {
      logger.info(`Triggering attempt ${i}/5`, { attempt: i });

      const handle = await processDataUpdate.trigger(
        {
          userId: key,
          data: {
            attempt: i,
            triggeredAt: new Date().toISOString(),
            message: `This is trigger attempt ${i}`,
          },
        },
        {
          debounce: {
            key: key,
            delay: "5s",
          },
        }
      );

      handles.push(handle.id);
      logger.info(`Attempt ${i} returned run ID: ${handle.id}`, {
        attempt: i,
        runId: handle.id,
      });

      // Small delay between triggers (but still within debounce window)
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Check if all handles are the same (they should be!)
    const uniqueHandles = [...new Set(handles)];
    const allSameRun = uniqueHandles.length === 1;

    logger.info("Debounce demonstration complete", {
      totalTriggers: 5,
      uniqueRuns: uniqueHandles.length,
      allSameRun,
      runIds: handles,
    });

    if (allSameRun) {
      logger.info("SUCCESS: All 5 triggers returned the same run ID - debounce is working!");
    } else {
      logger.warn("UNEXPECTED: Multiple runs were created", { uniqueHandles });
    }

    return {
      debounceKey: key,
      totalTriggers: 5,
      uniqueRunsCreated: uniqueHandles.length,
      allSameRun,
      runId: uniqueHandles[0],
    };
  },
});

/**
 * Demonstration: Debounce with triggerAndWait
 *
 * This shows how multiple parent tasks can wait on the same debounced child.
 * Each parent task calls triggerAndWait with the same debounce key.
 * All parents will be blocked by and receive the result from the SAME child run.
 *
 * To test this:
 * 1. Run "demonstrate-debounce-trigger-and-wait-orchestrator"
 * 2. Watch as 3 parent runs are created
 * 3. All 3 parents will wait for the SAME debounced child run
 * 4. When the child completes, all 3 parents complete with the same result
 */

// Parent task that calls triggerAndWait with debounce
export const debounceTriggerAndWaitParent = task({
  id: "debounce-trigger-and-wait-parent",
  run: async (payload: { parentNumber: number; debounceKey: string }) => {
    logger.info(`Parent ${payload.parentNumber}: Starting`, {
      parentNumber: payload.parentNumber,
      debounceKey: payload.debounceKey,
    });

    logger.info(`Parent ${payload.parentNumber}: Calling triggerAndWait with debounce`);

    // This will be debounced - if another parent calls with the same key,
    // they'll both wait for the same child run
    const result = await processDataUpdate.triggerAndWait(
      {
        userId: payload.debounceKey,
        data: {
          parentNumber: payload.parentNumber,
          triggeredAt: new Date().toISOString(),
        },
      },
      {
        debounce: {
          key: payload.debounceKey,
          delay: "5s",
        },
      }
    );

    logger.info(`Parent ${payload.parentNumber}: Got result from child`, { result });

    if (result.ok) {
      return {
        parentNumber: payload.parentNumber,
        childOutput: result.output,
        success: true,
      };
    } else {
      return {
        parentNumber: payload.parentNumber,
        error: "Child task failed",
        success: false,
      };
    }
  },
});

// Orchestrator that triggers multiple parents (without waiting)
export const demonstrateDebounceTriggerAndWaitOrchestrator = task({
  id: "demonstrate-debounce-trigger-and-wait-orchestrator",
  run: async (payload: { debounceKey?: string; parentCount?: number }) => {
    const key = payload.debounceKey ?? "wait-demo-key";
    const count = payload.parentCount ?? 3;

    logger.info("Starting debounce triggerAndWait demonstration", {
      debounceKey: key,
      parentCount: count,
    });

    logger.info(
      `Triggering ${count} parent tasks - each will call triggerAndWait with the same debounce key`
    );
    logger.info("All parents should be blocked by the SAME debounced child run");

    const handles: string[] = [];

    // Trigger multiple parent tasks as fast as possible (no delay) to maximize race condition chance
    for (let i = 1; i <= count; i++) {
      const handle = await debounceTriggerAndWaitParent.trigger({
        parentNumber: i,
        debounceKey: key,
      });

      logger.info(`Triggered parent ${i}`, { runId: handle.id });
      handles.push(handle.id);
    }

    logger.info("All parent tasks triggered", {
      parentRunIds: handles,
      debounceKey: key,
    });

    logger.info(
      "Watch the parent runs - they should all complete around the same time when the single debounced child finishes"
    );

    return {
      debounceKey: key,
      parentCount: count,
      parentRunIds: handles,
      message: `Triggered ${count} parent tasks. They will all wait for the same debounced child.`,
    };
  },
});

/**
 * Example 2: User Activity Debouncing
 *
 * A real-world use case: debouncing user activity updates.
 * When a user performs multiple actions in quick succession,
 * we only want to process the final state after they've stopped.
 *
 * Common use cases:
 * - Search-as-you-type
 * - Form auto-save
 * - Activity logging
 * - Rate limiting user actions
 */
export const syncUserActivity = task({
  id: "sync-user-activity",
  run: async (payload: {
    userId: string;
    activityType: string;
    details: Record<string, unknown>;
  }) => {
    logger.info("Syncing user activity", { payload });

    // Simulate syncing to external service
    await wait.for({ seconds: 2 });

    logger.info("User activity synced", {
      userId: payload.userId,
      activityType: payload.activityType,
    });

    return {
      synced: true,
      syncedAt: new Date().toISOString(),
    };
  },
});

export const trackUserActivity = task({
  id: "track-user-activity",
  run: async (payload: { userId: string; action: string; metadata?: Record<string, unknown> }) => {
    logger.info("Tracking user activity", { payload });

    // Debounce per user - if the same user performs multiple actions,
    // only sync once after 10 seconds of inactivity
    const handle = await syncUserActivity.trigger(
      {
        userId: payload.userId,
        activityType: payload.action,
        details: {
          ...payload.metadata,
          lastAction: payload.action,
          lastActionAt: new Date().toISOString(),
        },
      },
      {
        debounce: {
          // Key is scoped to the user, so each user has their own debounce window
          key: `user-${payload.userId}`,
          delay: "10s",
        },
      }
    );

    logger.info("User activity tracked (debounced)", {
      userId: payload.userId,
      runId: handle.id,
    });

    return { runId: handle.id };
  },
});

/**
 * Example 3: Document Auto-Save with Debounce
 *
 * Simulates a document editing system where saves are debounced
 * to avoid excessive save operations during rapid editing.
 */
export const saveDocument = task({
  id: "save-document",
  run: async (payload: { documentId: string; content: string; version: number }) => {
    logger.info("Saving document", {
      documentId: payload.documentId,
      contentLength: payload.content.length,
      version: payload.version,
    });

    // Simulate save operation
    await wait.for({ seconds: 1 });

    logger.info("Document saved successfully", {
      documentId: payload.documentId,
      savedAt: new Date().toISOString(),
    });

    return {
      saved: true,
      documentId: payload.documentId,
      version: payload.version,
      savedAt: new Date().toISOString(),
    };
  },
});

export const onDocumentEdit = task({
  id: "on-document-edit",
  run: async (payload: { documentId: string; content: string; editorId: string }) => {
    logger.info("Document edited", {
      documentId: payload.documentId,
      editorId: payload.editorId,
    });

    // Debounce saves per document - save only after 3 seconds of no edits
    const handle = await saveDocument.trigger(
      {
        documentId: payload.documentId,
        content: payload.content,
        version: Date.now(),
      },
      {
        debounce: {
          // Key is scoped to the document, so each document has its own debounce
          key: `doc-${payload.documentId}`,
          delay: "3s",
        },
      }
    );

    return {
      acknowledged: true,
      pendingSaveRunId: handle.id,
    };
  },
});

/**
 * Example 4: Webhook Consolidation
 *
 * When receiving many webhooks from an external service,
 * debounce to consolidate them into fewer processing runs.
 */
export const processWebhookBatch = task({
  id: "process-webhook-batch",
  run: async (payload: { source: string; eventType: string; data: unknown }) => {
    logger.info("Processing webhook batch", {
      source: payload.source,
      eventType: payload.eventType,
    });

    // Process the webhook data
    await wait.for({ seconds: 2 });

    logger.info("Webhook batch processed", {
      source: payload.source,
      eventType: payload.eventType,
    });

    return {
      processed: true,
      processedAt: new Date().toISOString(),
    };
  },
});

export const handleWebhook = task({
  id: "handle-webhook",
  run: async (payload: { source: string; eventType: string; webhookId: string; data: unknown }) => {
    logger.info("Received webhook", {
      source: payload.source,
      eventType: payload.eventType,
      webhookId: payload.webhookId,
    });

    // Debounce webhooks from the same source and event type
    // This consolidates rapid webhook bursts into single processing runs
    const handle = await processWebhookBatch.trigger(
      {
        source: payload.source,
        eventType: payload.eventType,
        data: payload.data,
      },
      {
        debounce: {
          key: `webhook-${payload.source}-${payload.eventType}`,
          delay: "2s",
        },
      }
    );

    logger.info("Webhook queued for processing (debounced)", {
      webhookId: payload.webhookId,
      runId: handle.id,
    });

    return {
      acknowledged: true,
      processingRunId: handle.id,
    };
  },
});

/**
 * Example 5: Debounce with triggerAndWait
 *
 * When using triggerAndWait with debounce, the parent task will be blocked
 * by the debounced child run. If another parent triggers with the same
 * debounce key, it will also be blocked by the SAME child run.
 */
export const debouncedChildTask = task({
  id: "debounced-child-task",
  run: async (payload: { key: string; value: string }) => {
    logger.info("Debounced child task executing", { payload });

    await wait.for({ seconds: 3 });

    logger.info("Debounced child task completed", { key: payload.key });

    return {
      result: `Processed: ${payload.value}`,
      completedAt: new Date().toISOString(),
    };
  },
});

export const parentWithDebouncedChild = task({
  id: "parent-with-debounced-child",
  run: async (payload: { parentId: string; debounceKey: string; data: string }) => {
    logger.info("Parent task starting", { parentId: payload.parentId });

    // triggerAndWait with debounce - the parent will wait for the debounced child
    // If another parent triggers with the same debounce key, they'll both wait
    // for the same child run
    const result = await debouncedChildTask.triggerAndWait(
      {
        key: payload.debounceKey,
        value: payload.data,
      },
      {
        debounce: {
          key: payload.debounceKey,
          delay: "5s",
        },
      }
    );

    logger.info("Parent task completed", {
      parentId: payload.parentId,
      childResult: result,
    });

    if (result.ok) {
      return {
        parentId: payload.parentId,
        childOutput: result.output,
      };
    } else {
      return {
        parentId: payload.parentId,
        error: "Child task failed",
      };
    }
  },
});

/**
 * Example 6: Different Delay Durations
 *
 * Shows various delay duration formats supported by debounce.
 */
export const shortDebounce = task({
  id: "short-debounce",
  run: async (payload: { key: string }) => {
    logger.info("Short debounce task (500ms)", { key: payload.key });
    return { key: payload.key, delay: "500ms" };
  },
});

export const mediumDebounce = task({
  id: "medium-debounce",
  run: async (payload: { key: string }) => {
    logger.info("Medium debounce task (5s)", { key: payload.key });
    return { key: payload.key, delay: "5s" };
  },
});

export const longDebounce = task({
  id: "long-debounce",
  run: async (payload: { key: string }) => {
    logger.info("Long debounce task (1m)", { key: payload.key });
    return { key: payload.key, delay: "1m" };
  },
});

export const testDifferentDelays = task({
  id: "test-different-delays",
  run: async (payload: { key: string }) => {
    logger.info("Testing different debounce delays", { key: payload.key });

    // 500ms debounce - good for rapid UI updates
    await shortDebounce.trigger(
      { key: `${payload.key}-short` },
      { debounce: { key: `${payload.key}-short`, delay: "500ms" } }
    );

    // 5 second debounce - good for user input
    await mediumDebounce.trigger(
      { key: `${payload.key}-medium` },
      { debounce: { key: `${payload.key}-medium`, delay: "5s" } }
    );

    // 1 minute debounce - good for batch processing
    await longDebounce.trigger(
      { key: `${payload.key}-long` },
      { debounce: { key: `${payload.key}-long`, delay: "1m" } }
    );

    return { triggered: true };
  },
});
