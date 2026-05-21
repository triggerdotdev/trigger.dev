import { describe, expectTypeOf, it } from "vitest";
import type { ApiPromise } from "@trigger.dev/core/v3";
import { batch } from "./batch.js";
import { runs } from "./runs.js";
import * as envvars from "./envvars.js";
import * as schedules from "./schedules/index.js";
import * as prompts from "./prompts.js";
import { auth } from "./auth.js";
import type { Task, AnyTask } from "./shared.js";
import { TriggerClient } from "./triggerClient.js";

// Stand-in task type used to verify generic inference flows through the proxy.
// Mirrors the shape returned by `task({...})` calls.
type ExampleTask = Task<"example", { to: string }, { sent: boolean }>;

const client = new TriggerClient({ accessToken: "tr_x" });

describe("TriggerClient surface — type-level guarantees", () => {
  it("preserves generic inference on tasks.trigger<typeof t>", () => {
    // If the proxy cast in bindToScope ever erodes generics, this fails:
    // the return type degrades to `unknown` and `.id`/`.taskIdentifier`
    // disappear.
    type Returned = ReturnType<typeof client.tasks.trigger<ExampleTask>>;
    expectTypeOf<Returned>().resolves.toHaveProperty("id");
    expectTypeOf<Returned>().resolves.toHaveProperty("taskIdentifier");
  });

  it("preserves return type on runs.retrieve (no double-wrap)", () => {
    // bindToScope wraps the impl as () => sdkScope.withScope(...). If the
    // wrapper were typed loosely it could surface as Promise<ApiPromise<...>>.
    // We want the original ApiPromise<...> to flow through unchanged.
    const handle = client.runs.retrieve<ExampleTask>("run_x");
    expectTypeOf(handle).toEqualTypeOf<ReturnType<typeof runs.retrieve<ExampleTask>>>();
    // And it should be assignable to a plain Promise (since ApiPromise extends Promise).
    expectTypeOf(handle).toMatchTypeOf<Promise<unknown>>();
  });

  it("preserves envvars.list overloads (projectRef+slug form AND zero-arg form)", () => {
    // Two-arg form
    expectTypeOf(client.envvars.list).toBeCallableWith("proj_1234", "dev");
    // Zero-arg form (uses task context — still typeable at the call site)
    expectTypeOf(client.envvars.list).toBeCallableWith();
  });
});

describe("TriggerClient surface — curated subsets", () => {
  it("instance.tasks drops inside-task-only and definition-time helpers", () => {
    type Keys = keyof typeof client.tasks;
    expectTypeOf<Keys>().toEqualTypeOf<"trigger" | "batchTrigger">();
    // @ts-expect-error — triggerAndWait is not on the instance surface.
    client.tasks.triggerAndWait;
    // @ts-expect-error — batchTriggerAndWait is not on the instance surface.
    client.tasks.batchTriggerAndWait;
    // @ts-expect-error — triggerAndSubscribe requires a task context; not on the instance surface.
    client.tasks.triggerAndSubscribe;
    // @ts-expect-error — hooks like onStart are task-definition-time, not on the client.
    client.tasks.onStart;
  });

  it("instance.batch drops the *AndWait variants that depend on the runtime", () => {
    type Keys = keyof typeof client.batch;
    expectTypeOf<Keys>().toEqualTypeOf<"trigger" | "triggerByTask" | "retrieve">();
    // @ts-expect-error
    client.batch.triggerAndWait;
    // @ts-expect-error
    client.batch.triggerByTaskAndWait;
    // The module-level export still has them — sanity check we didn't change that.
    expectTypeOf(batch).toHaveProperty("triggerAndWait");
  });

  it("instance.schedules drops `task` definition helper and `timezones` stateless helper", () => {
    type Keys = keyof typeof client.schedules;
    expectTypeOf<Keys>().toEqualTypeOf<
      "activate" | "create" | "deactivate" | "del" | "list" | "retrieve" | "update"
    >();
    // @ts-expect-error
    client.schedules.task;
    // @ts-expect-error
    client.schedules.timezones;
    // Module-level export still has them.
    expectTypeOf(schedules).toHaveProperty("task");
    expectTypeOf(schedules).toHaveProperty("timezones");
  });

  it("instance.prompts drops `define`", () => {
    // @ts-expect-error
    client.prompts.define;
    // Module-level export still has it.
    expectTypeOf(prompts).toHaveProperty("define");
  });

  it("instance.auth is the public-token subset only (no configure/withAuth)", () => {
    type Keys = keyof typeof client.auth;
    expectTypeOf<Keys>().toEqualTypeOf<
      "createPublicToken" | "createTriggerPublicToken" | "createBatchTriggerPublicToken"
    >();
    // @ts-expect-error — configure is global-only, not on the instance.
    client.auth.configure;
    // @ts-expect-error — withAuth is global-only.
    client.auth.withAuth;
    // Module-level export still has them.
    expectTypeOf(auth).toHaveProperty("configure");
    expectTypeOf(auth).toHaveProperty("withAuth");
  });
});

describe("TriggerClient surface — namespaces match their module sources", () => {
  // These are the load-bearing assertions for the bindToScope cast. If the
  // `as unknown as Pick<T, K>` ever drops or widens the underlying signatures,
  // these break.
  it("client.runs is structurally `typeof runs`", () => {
    expectTypeOf(client.runs).toEqualTypeOf<typeof runs>();
  });

  it("client.envvars is structurally `typeof envvars`", () => {
    expectTypeOf(client.envvars).toEqualTypeOf<typeof envvars>();
  });
});
