# Trigger.dev v4 Rules

**MUST use `@trigger.dev/sdk` (v4), NEVER `client.defineJob`**

```ts
import { task, queue, metadata, logger, locals, tasks, idempotencyKeys } from "@trigger.dev/sdk";

// Queue definition
const processQueue = queue({ name: "process-queue", concurrencyLimit: 3 });

// Locals for shared data
const ApiClientLocal = locals.create<{ client: any }>("apiClient");

// Global middleware
tasks.middleware("api-client", async ({ next }) => {
  locals.set(ApiClientLocal, { client: new ApiClient() });
  await next();
});

// Comprehensive task with all features
export const processData = task({
  id: "process-data",
  queue: processQueue,
  machine: { preset: "medium-1x" },
  maxDuration: 600,
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1000 },
  
  onStart: async ({ payload, ctx }) => {
    logger.info("Task started", { userId: payload.userId });
    metadata.set("status", "started").set("progress", 0);
  },
  
  onSuccess: async ({ payload, output, ctx }) => {
    logger.info("Task completed", { result: output });
  },
  
  onFailure: async ({ payload, error, ctx }) => {
    logger.error("Task failed", { error: error.message });
  },
  
  catchError: async ({ error, ctx }) => {
    return { retry: error.code !== "FATAL_ERROR" };
  },
  
  cleanup: async ({ payload, ctx }) => {
    logger.debug("Cleanup completed");
  },
  
  run: async (payload: { userId: string; data: any[] }, { ctx }) => {
    const client = locals.get(ApiClientLocal);
    
    // Process data with progress tracking
    for (let i = 0; i < payload.data.length; i++) {
      const item = payload.data[i];
      
      // Idempotent child task
      const idempotencyKey = await idempotencyKeys.create(`process-${item.id}`);
      const result = await childTask.triggerAndWait(item, { idempotencyKey });
      
      // Update metadata
      const progress = (i + 1) / payload.data.length;
      metadata.set("progress", progress)
        .append("processed", item.id)
        .increment("count", 1);
      
      logger.info("Item processed", { itemId: item.id, progress });
    }
    
    return { processed: payload.data.length, userId: payload.userId };
  },
});

export const childTask = task({
  id: "child-task", 
  run: async (item: any) => ({ result: `processed-${item.id}` })
});
```

**Trigger from backend:**
```ts
const handle = await tasks.trigger<typeof processData>("process-data", 
  { userId: "123", data: [{ id: 1 }, { id: 2 }] },
  { metadata: { source: "api" } }
);
```

**Key v4 changes:** Import from `@trigger.dev/sdk`, lifecycle hooks use `({ payload, ctx })`, `handleError` ’ `catchError`, queues defined with `queue()`, middleware replaces `init`.