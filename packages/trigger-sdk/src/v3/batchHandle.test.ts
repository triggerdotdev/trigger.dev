import { describe, expectTypeOf, it } from "vitest";
import type { batch } from "./batch.js";
import { createTask } from "./shared.js";
import type { tasks } from "./tasks.js";

type Payload = { i: number };

const taskA = createTask({
  id: "task-a",
  run: async (_payload: Payload) => ({ a: true }),
});

const taskB = createTask({
  id: "task-b",
  run: async (_payload: Payload) => ({ b: 1 }),
});

describe("batch trigger handles", () => {
  it("types every non-waiting handle with the fields returned at runtime", () => {
    type ByTask = Awaited<ReturnType<typeof batch.triggerByTask<[typeof taskA, typeof taskB]>>>;
    type ById = Awaited<ReturnType<typeof batch.trigger<typeof taskA | typeof taskB>>>;
    type FromTasks = Awaited<ReturnType<typeof tasks.batchTrigger<typeof taskA>>>;
    type FromTask = Awaited<ReturnType<typeof taskA.batchTrigger>>;

    expectTypeOf<ByTask["batchId"]>().toEqualTypeOf<string>();
    expectTypeOf<ByTask["runCount"]>().toEqualTypeOf<number>();
    expectTypeOf<ByTask["publicAccessToken"]>().toEqualTypeOf<string>();
    expectTypeOf<ByTask>().not.toHaveProperty("runs");
    expectTypeOf<ByTask>().not.toHaveProperty("isCached");
    expectTypeOf<ByTask>().not.toHaveProperty("idempotencyKey");

    for (const _ of [] as Array<ById | FromTasks | FromTask>) {
      expectTypeOf(_.batchId).toEqualTypeOf<string>();
      expectTypeOf(_.runCount).toEqualTypeOf<number>();
      expectTypeOf(_.publicAccessToken).toEqualTypeOf<string>();
    }
    expectTypeOf<ById>().not.toHaveProperty("runs");
    expectTypeOf<FromTasks>().not.toHaveProperty("runs");
    expectTypeOf<FromTask>().not.toHaveProperty("runs");
  });
});
