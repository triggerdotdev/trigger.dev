import { idempotencyKeys, logger, task, wait, AbortTaskRunError } from "@trigger.dev/sdk/v3";

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
        idempotencyKey: await idempotencyKeys.create(payload.key),
      }
    );

    if (childTaskResponse.ok) {
      logger.log("Child task response", { output: childTaskResponse.output });
    } else {
      logger.error("Child task error", { error: childTaskResponse.error });
    }

    await idempotencyKeyChild2.triggerAndWait(
      {
        key: payload.key,
        forceError: false,
      },
      {
        idempotencyKey: await idempotencyKeys.create(payload.key),
      }
    );

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

    await wait.for({ seconds: 2 });

    if (payload.forceError) {
      throw new AbortTaskRunError("This is a forced error in idempotency-key-child");
    }

    return payload;
  },
});

export const idempotencyKeyChild2 = task({
  id: "idempotency-key-child-2",
  run: async (payload: { forceError: boolean; key: string }) => {
    console.log("Hello from idempotency-key-child-2", payload.key);

    await wait.for({ seconds: 2 });

    return payload;
  },
});

export const idempotencyKeyBatchParent = task({
  id: "idempotency-key-batch-parent",
  run: async (payload: { keyPrefix: string; itemCount: number }) => {
    console.log("Hello from idempotency-key-batch-parent");

    const childTaskResponse = await idempotencyKeyBatchChild.batchTriggerAndWait(
      await Promise.all(
        Array.from({ length: payload.itemCount }).map(async (_, index) => ({
          payload: {
            key: `${payload.keyPrefix}-${index}`,
            forceError: index % 2 === 0,
            waitSeconds: 5 * index,
          },
          options: {
            idempotencyKey: await idempotencyKeys.create([payload.keyPrefix, String(index)]),
          },
        }))
      )
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

export const idempotencyKeyParentUsage = task({
  id: "idempotency-key-parent-usage",
  run: async (payload: { key: string; scope: "run" | "attempt" | "global" }, { ctx }) => {
    console.log(`Hello from idempotency-key-parent-usage, attempt #${ctx.attempt.number}`);

    const idempotencyKey = await idempotencyKeys.create(payload.key, { scope: payload.scope });

    console.log(`Generated idempotency key: ${idempotencyKey}`);

    const childTaskResponse = await idempotencyKeyChild.triggerAndWait(
      {
        key: idempotencyKey,
        forceError: true,
      },
      {
        idempotencyKey,
      }
    );

    if (childTaskResponse.ok) {
      logger.log("Child task response", { output: childTaskResponse.output });
    } else {
      logger.error("Child task error", { error: childTaskResponse.error });

      if (ctx.attempt.number > 1) {
        throw new AbortTaskRunError("Child task failed on retry, exiting parent task");
      } else {
        throw new Error("Child task failed");
      }
    }

    return {
      key: payload.key,
      childTaskResponse,
    };
  },
});
