import { batch, idempotencyKeys, logger, task, timeout, usage, wait } from "@trigger.dev/sdk/v3";
import { setTimeout } from "timers/promises";
import { childTask } from "./example.js";

export const idempotency = task({
  id: "idempotency",
  maxDuration: 60,
  run: async (payload: any, { ctx }) => {
    logger.log("Hello, world from the parent", { payload });

    const successfulKey = await idempotencyKeys.create("a", { scope: "global" });

    const child1 = await childTask.triggerAndWait(
      { message: "Hello, world!", duration: 500, failureChance: 0 },
      { idempotencyKey: successfulKey, idempotencyKeyTTL: "120s" }
    );
    logger.log("Child 1", { child1 });
    const child2 = await childTask.triggerAndWait(
      { message: "Hello, world!", duration: 500 },
      { idempotencyKey: successfulKey, idempotencyKeyTTL: "120s" }
    );
    logger.log("Child 2", { child2 });
    await childTask.trigger(
      { message: "Hello, world!", duration: 500, failureChance: 0 },
      { idempotencyKey: successfulKey, idempotencyKeyTTL: "120s" }
    );

    const failureKey = await idempotencyKeys.create("b", { scope: "global" });

    const child3 = await childTask.triggerAndWait(
      { message: "Hello, world!", duration: 500, failureChance: 1 },
      { idempotencyKey: failureKey, idempotencyKeyTTL: "120s" }
    );
    logger.log("Child 3", { child3 });
    const child4 = await childTask.triggerAndWait(
      { message: "Hello, world!", duration: 500, failureChance: 1 },
      { idempotencyKey: failureKey, idempotencyKeyTTL: "120s" }
    );
    logger.log("Child 4", { child4 });

    const anotherKey = await idempotencyKeys.create("c", { scope: "global" });

    const batch1 = await childTask.batchTriggerAndWait([
      {
        payload: { message: "Hello, world!" },
        options: { idempotencyKey: successfulKey, idempotencyKeyTTL: "120s" },
      },
      {
        payload: { message: "Hello, world 2!" },
        options: { idempotencyKey: failureKey, idempotencyKeyTTL: "120s" },
      },
      {
        payload: { message: "Hello, world 3", duration: 500, failureChance: 0 },
        options: { idempotencyKey: anotherKey, idempotencyKeyTTL: "120s" },
      },
    ]);
    logger.log("Batch 1", { batch1 });

    await childTask.batchTrigger([
      {
        payload: { message: "Hello, world!" },
        options: { idempotencyKey: successfulKey, idempotencyKeyTTL: "120s" },
      },
      {
        payload: { message: "Hello, world 2!" },
        options: { idempotencyKey: failureKey, idempotencyKeyTTL: "120s" },
      },
    ]);

    const results2 = await batch.triggerAndWait<typeof childTask>([
      {
        id: "child",
        payload: { message: "Hello, world !" },
        options: { idempotencyKey: successfulKey, idempotencyKeyTTL: "60s" },
      },
      {
        id: "child",
        payload: { message: "Hello, world 2!" },
        options: { idempotencyKey: failureKey, idempotencyKeyTTL: "60s" },
      },
    ]);
    logger.log("Results 2", { results2 });

    const results3 = await batch.triggerByTask([
      {
        task: childTask,
        payload: { message: "Hello, world !" },
        options: { idempotencyKey: successfulKey, idempotencyKeyTTL: "60s" },
      },
      {
        task: childTask,
        payload: { message: "Hello, world 2!" },
        options: { idempotencyKey: failureKey, idempotencyKeyTTL: "60s" },
      },
    ]);
    logger.log("Results 3", { results3 });

    const results4 = await batch.triggerByTaskAndWait([
      {
        task: childTask,
        payload: { message: "Hello, world !" },
        options: { idempotencyKey: successfulKey, idempotencyKeyTTL: "60s" },
      },
      {
        task: childTask,
        payload: { message: "Hello, world 2!" },
        options: { idempotencyKey: failureKey, idempotencyKeyTTL: "60s" },
      },
    ]);
    logger.log("Results 4", { results4 });
  },
});
