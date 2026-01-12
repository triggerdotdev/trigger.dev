import { batch, logger, task, wait } from "@trigger.dev/sdk/v3";

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
    logger.info("Short debounce task (1s)", { key: payload.key });
    return { key: payload.key, delay: "1s" };
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

    // 1 second debounce - good for rapid UI updates
    await shortDebounce.trigger(
      { key: `${payload.key}-short` },
      { debounce: { key: `${payload.key}-short`, delay: "1s" } }
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

/**
 * Example 7: Batch Trigger with Debounce
 *
 * Demonstrates using debounce with batchTrigger.
 * Each item in the batch can have its own debounce key and delay.
 * Items with the same debounce key will be consolidated into a single run.
 */
export const batchItemTask = task({
  id: "batch-item-task",
  run: async (payload: { itemId: string; data: string }) => {
    logger.info("Processing batch item", { payload });

    await wait.for({ seconds: 1 });

    logger.info("Batch item processed", { itemId: payload.itemId });

    return {
      processed: true,
      itemId: payload.itemId,
      processedAt: new Date().toISOString(),
    };
  },
});

/**
 * Demonstrates batch.trigger() with debounce options on individual items.
 *
 * This shows how you can:
 * - Use different debounce keys for different items
 * - Items with the same debounce key will be consolidated
 * - Items with different keys will create separate runs
 *
 * Run this task and watch:
 * - Items 1 and 3 share debounce key "group-a" -> ONE run
 * - Items 2 and 4 share debounce key "group-b" -> ONE run
 * - Item 5 has unique key "group-c" -> ONE run
 * - Total: 3 runs instead of 5 (but batch shows 5 items)
 *
 * Note: The batch itself still reports 5 items, but only 3 actual task runs
 * will execute due to debouncing.
 */
export const demonstrateBatchDebounce = task({
  id: "demonstrate-batch-debounce",
  run: async (payload: { prefix?: string }) => {
    const prefix = payload.prefix ?? "batch-demo";

    logger.info("Starting batch debounce demonstration");
    logger.info("Will trigger 5 items with 3 different debounce keys");
    logger.info(
      "Items 1&3 share key 'group-a', items 2&4 share key 'group-b', item 5 has key 'group-c'"
    );

    // Use batch.trigger with debounce options on each item
    const result = await batch.trigger<typeof batchItemTask>([
      {
        id: "batch-item-task",
        payload: { itemId: `${prefix}-1`, data: "First item in group A" },
        options: {
          debounce: { key: `${prefix}-group-a`, delay: "5s" },
        },
      },
      {
        id: "batch-item-task",
        payload: { itemId: `${prefix}-2`, data: "First item in group B" },
        options: {
          debounce: { key: `${prefix}-group-b`, delay: "5s" },
        },
      },
      {
        id: "batch-item-task",
        payload: { itemId: `${prefix}-3`, data: "Second item in group A (debounced)" },
        options: {
          debounce: { key: `${prefix}-group-a`, delay: "5s" },
        },
      },
      {
        id: "batch-item-task",
        payload: { itemId: `${prefix}-4`, data: "Second item in group B (debounced)" },
        options: {
          debounce: { key: `${prefix}-group-b`, delay: "5s" },
        },
      },
      {
        id: "batch-item-task",
        payload: { itemId: `${prefix}-5`, data: "Only item in group C" },
        options: {
          debounce: { key: `${prefix}-group-c`, delay: "5s" },
        },
      },
    ]);

    logger.info("Batch debounce demonstration complete", {
      batchId: result.batchId,
      totalItemsInBatch: result.runCount,
      note: "Check the dashboard - only 3 actual task runs should execute due to debouncing",
    });

    return {
      batchId: result.batchId,
      totalItemsInBatch: result.runCount,
      expectedUniqueRuns: 3,
      message:
        "5 items submitted, but only 3 runs will execute: group-a (1 run), group-b (1 run), group-c (1 run)",
    };
  },
});

/**
 * Demonstrates batchTrigger on a single task with debounce.
 *
 * Similar to batch.trigger but using myTask.batchTrigger() syntax.
 * Each item can have its own debounce configuration.
 *
 * When all items share the same debounce key, only ONE run will execute.
 */
export const demonstrateSingleTaskBatchDebounce = task({
  id: "demonstrate-single-task-batch-debounce",
  run: async (payload: { debounceKey?: string }) => {
    const key = payload.debounceKey ?? "single-batch-demo";

    logger.info("Starting single task batch debounce demonstration", { debounceKey: key });
    logger.info("Triggering 4 items with the SAME debounce key - only 1 run should execute");

    // All items have the same debounce key, so they should all resolve to the same run
    const result = await batchItemTask.batchTrigger([
      {
        payload: { itemId: `${key}-1`, data: "Item 1" },
        options: { debounce: { key, delay: "5s" } },
      },
      {
        payload: { itemId: `${key}-2`, data: "Item 2" },
        options: { debounce: { key, delay: "5s" } },
      },
      {
        payload: { itemId: `${key}-3`, data: "Item 3" },
        options: { debounce: { key, delay: "5s" } },
      },
      {
        payload: { itemId: `${key}-4`, data: "Item 4" },
        options: { debounce: { key, delay: "5s" } },
      },
    ]);

    logger.info("Single task batch debounce complete", {
      batchId: result.batchId,
      totalItemsInBatch: result.runCount,
      debounceKey: key,
      note: "All items share the same debounce key, so only 1 task run should execute",
    });

    return {
      batchId: result.batchId,
      totalItemsInBatch: result.runCount,
      debounceKey: key,
      expectedUniqueRuns: 1,
      message: "4 items submitted with same debounce key - only 1 run will execute",
    };
  },
});

/**
 * Example 8: Trailing Mode - Process Latest Data
 *
 * Trailing mode updates the run's payload (and other options) with each subsequent trigger.
 * When the debounce window closes, the task runs with the LAST payload instead of the first.
 *
 * This is perfect for scenarios like:
 * - Auto-saving the latest document state
 * - Processing the final search query after typing stops
 * - Aggregating real-time data and processing the latest snapshot
 */
export const processLatestData = task({
  id: "process-latest-data",
  run: async (payload: { version: number; content: string; timestamp: string }) => {
    logger.info("Processing latest data", { payload });

    await wait.for({ seconds: 1 });

    logger.info("Processed latest data", {
      version: payload.version,
      content: payload.content,
    });

    return {
      processed: true,
      version: payload.version,
      content: payload.content,
      processedAt: new Date().toISOString(),
    };
  },
});

/**
 * Demonstrates trailing mode in action.
 *
 * This task triggers processLatestData 5 times rapidly with different payloads.
 * With mode: "trailing", the run will execute with version 5 (the LAST payload),
 * not version 1 (the first payload).
 *
 * Compare this to the demonstrateDebounce task which uses the default leading mode.
 */
export const demonstrateTrailingMode = task({
  id: "demonstrate-trailing-mode",
  run: async (payload: { debounceKey?: string }) => {
    const key = payload.debounceKey ?? "trailing-demo-key";

    logger.info("Starting trailing mode demonstration", { debounceKey: key });
    logger.info("Will trigger processLatestData 5 times with mode: 'trailing'");
    logger.info("The run should execute with version 5 (the LAST payload)");

    const handles: string[] = [];

    // Trigger 5 times rapidly - with trailing mode, the LAST payload wins
    for (let i = 1; i <= 5; i++) {
      logger.info(`Triggering version ${i}/5`, { version: i });

      const handle = await processLatestData.trigger(
        {
          version: i,
          content: `Content version ${i}`,
          timestamp: new Date().toISOString(),
        },
        {
          debounce: {
            key: key,
            delay: "5s",
            mode: "trailing", // Use trailing mode - LAST payload wins
          },
        }
      );

      handles.push(handle.id);
      logger.info(`Version ${i} returned run ID: ${handle.id}`, {
        version: i,
        runId: handle.id,
      });

      // Small delay between triggers
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // All handles should be the same run
    const uniqueHandles = [...new Set(handles)];
    const allSameRun = uniqueHandles.length === 1;

    logger.info("Trailing mode demonstration complete", {
      totalTriggers: 5,
      uniqueRuns: uniqueHandles.length,
      allSameRun,
      note: "The run should execute with version 5 (the LAST payload)",
    });

    return {
      debounceKey: key,
      totalTriggers: 5,
      uniqueRunsCreated: uniqueHandles.length,
      allSameRun,
      runId: uniqueHandles[0],
      expectedPayloadVersion: 5,
      message:
        "With trailing mode, the run executes with the LAST payload (version 5), not the first",
    };
  },
});

/**
 * Example 9: Document Auto-Save with Trailing Mode
 *
 * A practical example: when editing a document, you want to save the LATEST
 * version after the user stops typing, not the first version.
 *
 * Trailing mode is ideal for this because:
 * - Each keystroke/edit triggers a save
 * - Each trigger updates the pending run's payload to the latest content
 * - When typing stops, the latest content is saved
 */
export const saveDocumentLatest = task({
  id: "save-document-latest",
  run: async (payload: {
    documentId: string;
    content: string;
    editCount: number;
    lastEditedAt: string;
  }) => {
    logger.info("Saving document (latest version)", {
      documentId: payload.documentId,
      contentLength: payload.content.length,
      editCount: payload.editCount,
    });

    // Simulate save operation
    await wait.for({ seconds: 1 });

    logger.info("Document saved successfully with latest content", {
      documentId: payload.documentId,
      editCount: payload.editCount,
      savedAt: new Date().toISOString(),
    });

    return {
      saved: true,
      documentId: payload.documentId,
      editCount: payload.editCount,
      contentLength: payload.content.length,
      savedAt: new Date().toISOString(),
    };
  },
});

export const onDocumentEditWithTrailing = task({
  id: "on-document-edit-with-trailing",
  run: async (payload: { documentId: string; content: string; editorId: string }) => {
    // Track how many edits we've made (for demonstration)
    const editCount = payload.content.length; // Using content length as a simple proxy

    logger.info("Document edited (using trailing mode)", {
      documentId: payload.documentId,
      editorId: payload.editorId,
      editCount,
    });

    // Use trailing mode - the LATEST content will be saved
    const handle = await saveDocumentLatest.trigger(
      {
        documentId: payload.documentId,
        content: payload.content,
        editCount,
        lastEditedAt: new Date().toISOString(),
      },
      {
        debounce: {
          key: `doc-${payload.documentId}`,
          delay: "3s",
          mode: "trailing", // Save the LATEST content, not the first
        },
      }
    );

    return {
      acknowledged: true,
      pendingSaveRunId: handle.id,
      note: "With trailing mode, the latest content will be saved after 3 seconds of no edits",
    };
  },
});

/**
 * Example 10: Leading vs Trailing Mode Comparison
 *
 * This task demonstrates the difference between leading and trailing modes
 * by triggering two separate debounced tasks with the same data pattern.
 *
 * - Leading mode task: will process version 1 (first payload)
 * - Trailing mode task: will process version 5 (last payload)
 */
export const processWithLeadingMode = task({
  id: "process-with-leading-mode",
  run: async (payload: { version: number }) => {
    logger.info("Leading mode: Processing data", { version: payload.version });
    return { mode: "leading", version: payload.version };
  },
});

export const processWithTrailingMode = task({
  id: "process-with-trailing-mode",
  run: async (payload: { version: number }) => {
    logger.info("Trailing mode: Processing data", { version: payload.version });
    return { mode: "trailing", version: payload.version };
  },
});

export const compareLeadingAndTrailing = task({
  id: "compare-leading-and-trailing",
  run: async (payload: { prefix?: string }) => {
    const prefix = payload.prefix ?? "compare";

    logger.info("Starting leading vs trailing mode comparison");
    logger.info("Triggering both modes 5 times with versions 1-5");
    logger.info("Expected: Leading mode processes v1, Trailing mode processes v5");

    // Trigger both modes 5 times
    for (let i = 1; i <= 5; i++) {
      // Leading mode (default) - will keep first payload
      await processWithLeadingMode.trigger(
        { version: i },
        {
          debounce: {
            key: `${prefix}-leading`,
            delay: "5s",
            // mode: "leading" is the default
          },
        }
      );

      // Trailing mode - will update to latest payload
      await processWithTrailingMode.trigger(
        { version: i },
        {
          debounce: {
            key: `${prefix}-trailing`,
            delay: "5s",
            mode: "trailing",
          },
        }
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    logger.info("Comparison complete", {
      leadingModeExpected: "version 1 (first payload)",
      trailingModeExpected: "version 5 (last payload)",
    });

    return {
      message: "Check the processWithLeadingMode and processWithTrailingMode runs",
      leadingModeExpected: { version: 1 },
      trailingModeExpected: { version: 5 },
    };
  },
});

/**
 * Example 11: Trailing Mode with Metadata Updates
 *
 * Trailing mode also updates metadata, tags, maxAttempts, maxDuration, and machine.
 * This example shows how metadata changes with each trigger.
 */
export const processWithMetadata = task({
  id: "process-with-metadata",
  run: async (payload: { action: string }, { ctx }) => {
    logger.info("Processing with metadata", { action: payload.action });

    // The metadata will be from the LAST trigger when using trailing mode
    logger.info("Run metadata reflects the latest trigger");

    return {
      action: payload.action,
      processedAt: new Date().toISOString(),
    };
  },
});

export const demonstrateTrailingWithMetadata = task({
  id: "demonstrate-trailing-with-metadata",
  run: async (payload: { debounceKey?: string }) => {
    const key = payload.debounceKey ?? "metadata-trailing-demo";

    logger.info("Demonstrating trailing mode with metadata updates");

    const actions = ["created", "updated", "reviewed", "approved", "published"];

    for (const action of actions) {
      await processWithMetadata.trigger(
        { action },
        {
          debounce: {
            key,
            delay: "5s",
            mode: "trailing",
          },
          metadata: {
            lastAction: action,
            actionTimestamp: new Date().toISOString(),
            actionIndex: actions.indexOf(action) + 1,
          },
        }
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    logger.info("Metadata trailing demonstration complete", {
      expectedAction: "published",
      expectedMetadata: { lastAction: "published", actionIndex: 5 },
    });

    return {
      debounceKey: key,
      triggeredActions: actions,
      expectedFinalAction: "published",
      message: "The run will have metadata from the 'published' trigger (the last one)",
    };
  },
});
