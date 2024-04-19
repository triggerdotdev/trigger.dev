import { logger, task, wait } from "@trigger.dev/sdk/v3";

export const idempotencyKeyParent = task({
  id: "idempotency-key-parent",
  run: async (payload: { key: string }) => {
    console.log("Hello from idempotency-key-parent");

    const childTaskResponse = await idempotencyKeyChild.triggerAndWait(
      {
        key: payload.key,
        forceError: true,
      },
      {
        idempotencyKey: payload.key,
      }
    );

    if (childTaskResponse.ok) {
      logger.log("Child task response", { output: childTaskResponse.output });
    } else {
      logger.error("Child task error", { error: childTaskResponse.error });
    }

    return {
      key: payload.key,
      childTaskResponse,
    };
  },
});

export const idempotencyKeyChild = task({
  id: "idempotency-key-child",
  run: async (payload: { forceError: boolean; key: string }) => {
    console.log("Hello from idempotency-key-child", payload.key);

    await wait.for({ seconds: 5 });

    if (payload.forceError) {
      throw new Error("This is a forced error in idempotency-key-child");
    }

    return payload;
  },
});

export const idempotencyKeyBatchParent = task({
  id: "idempotency-key-batch-parent",
  run: async (payload: { keyPrefix: string; itemCount: number }) => {
    console.log("Hello from idempotency-key-batch-parent");

    const childTaskResponse = await idempotencyKeyBatchChild.batchTriggerAndWait(
      Array.from({ length: payload.itemCount }).map((_, index) => ({
        payload: {
          key: `${payload.keyPrefix}-${index}`,
          forceError: index % 2 === 0,
          waitSeconds: 5 * index,
        },
        options: {
          idempotencyKey: `${payload.keyPrefix}-${index}`,
        },
      }))
    );

    return {
      keyPrefix: payload.keyPrefix,
      childTaskResponse,
    };
  },
});

export const idempotencyKeyBatchChild = task({
  id: "idempotency-key-batch-child",
  run: async (payload: { forceError: boolean; key: string; waitSeconds: number }) => {
    console.log("idempotency-key-batch-child", payload.key);

    await wait.for({ seconds: payload.waitSeconds });

    if (payload.forceError) {
      throw new Error(`This is a forced error in idempotency-key-batch-child ${payload.key}`);
    }

    return payload;
  },
});
