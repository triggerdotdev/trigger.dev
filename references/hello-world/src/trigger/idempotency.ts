import { batch, idempotencyKeys, logger, task, timeout, usage, wait } from "@trigger.dev/sdk/v3";
import { setTimeout } from "timers/promises";
import { childTask } from "./example.js";

export const idempotency = task({
  id: "idempotency",
  run: async (payload: any, { ctx }) => {
    logger.log("Hello, world from the parent", { payload });

    const successfulKey = await idempotencyKeys.create("a", { scope: "global" });

    const child1 = await childTask.triggerAndWait(
      { message: "Hello, world!", duration: 2_000 },
      { idempotencyKey: successfulKey, idempotencyKeyTTL: "60s" }
    );
    logger.log("Child 1", { child1 });
    const child2 = await childTask.triggerAndWait(
      { message: "Hello, world!", duration: 2_000 },
      { idempotencyKey: successfulKey, idempotencyKeyTTL: "60s" }
    );
    logger.log("Child 2", { child2 });

    const failureKey = await idempotencyKeys.create("b", { scope: "global" });

    const child3 = await childTask.triggerAndWait(
      { message: "Hello, world!", duration: 2_000, failureChance: 1 },
      { idempotencyKey: failureKey, idempotencyKeyTTL: "60s" }
    );
    logger.log("Child 3", { child3 });
    const child4 = await childTask.triggerAndWait(
      { message: "Hello, world!", duration: 2_000, failureChance: 1 },
      { idempotencyKey: failureKey, idempotencyKeyTTL: "60s" }
    );
    logger.log("Child 4", { child4 });

    // const results = await childTask.batchTriggerAndWait([
    //   {
    //     payload: { message: "Hello, world!" },
    //     //@ts-ignore
    //     options: { idempotencyKey: "1", idempotencyKeyTTL: "60s" },
    //   },
    //   {
    //     payload: { message: "Hello, world 2!" },
    //     //@ts-ignore
    //     options: { idempotencyKey: "2", idempotencyKeyTTL: "60s" },
    //   },
    // ]);
    // logger.log("Results", { results });

    // const results2 = await batch.triggerAndWait<typeof childTask>([
    //   {
    //     id: "child",
    //     payload: { message: "Hello, world !" },
    //     //@ts-ignore
    //     options: { idempotencyKey: "1", idempotencyKeyTTL: "60s" },
    //   },
    //   {
    //     id: "child",
    //     payload: { message: "Hello, world 2!" },
    //     //@ts-ignore
    //     options: { idempotencyKey: "2", idempotencyKeyTTL: "60s" },
    //   },
    // ]);
    // logger.log("Results 2", { results2 });

    // const results3 = await batch.triggerByTask([
    //   {
    //     task: childTask,
    //     payload: { message: "Hello, world !" },
    //     options: { idempotencyKey: "1", idempotencyKeyTTL: "60s" },
    //   },
    //   {
    //     task: childTask,
    //     payload: { message: "Hello, world 2!" },
    //     options: { idempotencyKey: "2", idempotencyKeyTTL: "60s" },
    //   },
    // ]);
    // logger.log("Results 3", { results3 });

    // const results4 = await batch.triggerByTaskAndWait([
    //   { task: childTask, payload: { message: "Hello, world !" } },
    //   { task: childTask, payload: { message: "Hello, world 2!" } },
    // ]);
    // logger.log("Results 4", { results4 });
  },
});
