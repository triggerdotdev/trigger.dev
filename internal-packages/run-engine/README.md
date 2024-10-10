# Trigger.dev Run Engine

The Run Engine process runs from triggering, to executing, and completing them.

It is responsible for:

- Creating and updating runs as they progress.
- Operating the run queue, including handling concurrency.

## Components

### Run Engine

This is used to actually process a run and store the state at each step. It coordinates with the other components.

#### Atomicity

Operations on the run are "atomic" in the sense that only a single operation can mutate them at a time. We use RedLock to ensure this.

#### Valid state transitions

The run engine ensures that the run can only transition to valid states.

#### State history

When a run is mutated in any way, we store the state. This data is used for the next step for the run, and also for debugging.

`TaskRunState` is a decent table name. We should have a "description" column which describes the change, this would be purely for internal use but would be very useful for debugging.

### Run Queue

This is used to queue, dequeue, and manage concurrency. It also provides visibility into the concurrency for the env, org, etc.

Run IDs are enqueued. They're pulled from the queue in a fair way with advanced options for debouncing and visibility.

### Heartbeats

Heartbeats are used to determine if a run has stopped responding. If a heartbeat isn't received within a defined period then the run is judged to have become stuck and the attempt is failed.

### Checkpoints

Checkpoints allow pausing an executing run and then resuming it later.

## Waitpoints

A "Waitpoint" is something that prevents a run from continuing:

- `wait.for()` a future time.
- `triggerAndWait()` until the run is finished.
- `batchTriggerAndWait()` until all runs are finished.
- `wait.forRequest()` wait until a request has been received (not implemented yet).

They block run execution from continuing until all of them are completed/removed.

Some of them have data associated with them, e.g. the finished run payload.

Could a run have multiple at once? That might allow us to support Promise.all wrapped. It would also allow more advanced use cases.

Could this be how we implement other features like `delay`, `rate limit`, and retries waiting before the next try?

Could we even open up a direct API/SDK for creating one inside a run (would pause execution)? And then completing one (would continue execution)? It could also be "failed" which the run could act upon differently.

## Notes from call with Eric

We could expose the API/SDK for creating/completing Waitpoints.

> They need to be associated with attempts, because that's what gets continued. And if an attempts fails, we don't want to keep the waitpoints.

> We should have idempotency keys for `wait.for()` and `wait.until()`, so they wouldn't wait on a second attempt. "Waitpoints" have idempotency keys, and these are used for a `wait.forEvent()` (or whatever we call it).

> How would debounce use this? When the waitpoint is completed, we would "clear" the "idempotencyKey" which would be the user-provided "debounceKey". It wouldn't literally clear it necessarily. Maybe another column `idempotencyKeyActive` would be set to `false`. Or move the key to another column, which is just for reference.

> `triggerAndWait`, cancelling a child task run. It would clear the waitpoint `idempotencyKey`, same as above.

> Copying the output from the run into the waitpoint actually does make sense. It simplifies the API for continuing runs.

> Inside a run you could wait for another run or runs using the run ID. `const output = await wait.forRunToComplete(runId)`. This would basically just get a run by ID, then wait for it's waitpoint to be completed. This means every run would have a waitpoint associated with it.

```ts
//inside a run function
import { runs } from "@trigger.dev/sdk/v3";

// Loop through all runs with the tag "user_123456" that have completed

for await (const run of runs.list({ tag: "user_123456" })) {
  await wait.forRunToComplete(run.id);
}

//wait for many runs to complete
await wait.forRunToComplete(runId);
await wait.forRunsToComplete({ tag: "user_123456" });
```

Rate limit inside a task. This is much trickier.

```ts
//simple time-based rate limit
await wait.forRateLimit(`timed-${payload.user.id}`, { per: { minute: 10 } });

const openAiResult = await wait.forRateLimit(
  `openai-${payload.user.id}`,
  { limit: 100, recharge: { seconds: 2 } },
  (rateLimit, refreshes) => {
    const result = await openai.createCompletion({
      model: "gpt-3.5-turbo",
      prompt: "What is the meaning of life?",
    });
    const tokensUsed = result.tokensUsed;

    await rateLimit.used(tokensUsed);

    return result;
  }
);

//do stuff with openAiResult
```

#### `triggerAndWait()` implementation

Inside the SDK

```ts
function triggerAndWait_internal(data) {
  //if you don't pass in a string, it won't have a "key"
  const waitpoint = await createWaitpoint();
  const response = await apiClient.triggerTask({ ...data, waitpointId: waitpoint.id });

  //...do normal stuff

  // wait for the waitpoint to be completed
  // in reality this probably needs to happen inside the runtime
  const result = await waitpointCompletion(waitpoint.id);
}
```

Pseudo-code for completing a run and completing the waitpoint:

```ts
function completeRun(tx, data) {
  //complete the child run
  const run = await tx.taskRun.update({ where: { id: runId }, data, include: { waitpoint } });
  if (run.waitpoint) {
    await completeWaitpoint(tx, { id: run.waitpoint.id });

    //todo in completeWaitpoint it would check if the blocked runs can now continue
    //if they have no more blockers then they can continue

    //batchTriggerAndWait with two items
    //blocked_by: ["w_1", "w_2"]
    //blocked_by: ["w_2"]
    //blocked_by: [] then you can continue
  }

  const state = await tx.taskRunState.create({
    where: { runId: id },
    data: { runId, status: run.status },
  });

  const previousState = await tx.taskRunState.findFirst({ where: { runId: runId, latest: true } });
  const waitingOn = previousState.waitingOn?.filter((w) => w !== waitpoint?.id) ?? [];

  if (waitingOn.length === 0) {
  }
}
```

#### `batchTriggerAndWait()` implementation

```ts
//todo
```

### Example: User-defined waitpoint

A user's backend code:

```ts
import { waitpoint } from "@trigger.dev/sdk/v3";
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse<{ id: string }>) {
  const userId = req.query.userId;
  const isPaying = req.query.isPaying;

  //internal SDK calls, this would be nicer for users to use
  const waitpoint = waitpoint(`${userId}/onboarding-completed`);
  await waitpoint.complete({ data: { isPaying } });

  //todo instead this would be a single call

  res.status(200).json(handle);
}
```

Inside a user's run

```ts
export const myTask = task({
  id: "my-task",
  run: async (payload) => {
    //it doesn't matter if this was completed before the run started
    const result = await wait.forPoint<{ isPaying: boolean }>(
      `${payload.userId}/onboarding-completed`
    );
  },
});
```

### How would we implement `batchTriggerAndWait`?

```ts

```

## How does it work?

It's very important that a run can only be acted on by one process at a time. We lock runs using RedLock while they're being mutated. This prevents some network-related race conditions like the timing of checkpoints and heartbeats permanently hanging runs.

# Sending messages to the worker

Sending messages to the worker is challenging because we many servers and we're going to have many workers. We need to make sure that the message is sent to the correct worker.

## #continueRun
When all waitpoints are finished, we need to continue a run. Sometimes they're still running in the cluster.

# Legacy system

These are all the TaskRun mutations happening right now:

## 1. TriggerTaskService

This is called from:

- trigger task API
- `BatchTriggerTaskService` for each item
- `ReplayTaskRunService`
- `TestTaskService`
- `TriggerScheduledTaskService` when the CRON fires

Directly creates a run if it doesn't exist, either in the `PENDING` or `DELAYED` states.
Enqueues the run.

[TriggerTaskService.call()](/apps//webapp/app/v3/services/triggerTask.server.ts#246)

## 2. Batch trigger

## 3. DevQueueConsumer executing a run

### a. Lock run and set status to `EXECUTING`

[DevQueueConsumer.#doWorkInternal()](/apps/webapp/app/v3/marqs/devQueueConsumer.server.ts#371)

### b. If an error is thrown, unlock the run and set status to `PENDING`

[DevQueueConsumer.#doWorkInternal()](/apps/webapp/app/v3/marqs/devQueueConsumer.server.ts#477)

## 4. SharedQueueConsumer executing a run

### a. `EXECUTE`, lock the run

We lock the run and update some basic metadata (but not status).
[SharedQueueConsumer.#doWorkInternal()](/apps/webapp/app/v3/marqs/sharedQueueConsumer.server.ts#394)

### b. `EXECUTE`, if an error is thrown, unlock the run

We unlock the run, but don't change the status.
[SharedQueueConsumer.#doWorkInternal()](/apps/webapp/app/v3/marqs/sharedQueueConsumer.server.ts#552)

### c. `EXECUTE`, if the run has no deployment set the status to `WAITING_FOR_DEPLOY`

[SharedQueueConsumer.#doWorkInternal()](/apps/webapp/app/v3/marqs/sharedQueueConsumer.server.ts#876)

## 5. CompleteAttemptService retrying a run

### a. When an attempt has failed, we set the status to `RETRYING_AFTER_FAILURE`

[CompleteAttemptService.#completeAttemptFailed()](/apps/webapp/app/v3/services/completeAttempt.server.ts#239)

## 6. CreateTaskRunAttemptService creating a new attempt, setting the run to `EXECUTING`

We call this when:

- [Executing a DEV run from the CLI.](/packages/cli-v3//src/dev/workerRuntime.ts#305)
- [Deprecated: directly from the SharedQueueCOnsumer when we don't support lazy attempts](/apps/webapp/app/v3/marqs/sharedQueueConsumer.server.ts#501)
- [When we receive a `CREATE_TASK_RUN_ATTEMPT` message from the coordinator](/apps/webapp//app/v3//handleSocketIo.server.ts#187)

This is the actual very simple TaskRun update:
[CreateTaskRunAttemptService.call()](/apps/webapp/app/v3/services/createTaskRunAttempt.server.ts#134)

## 7. EnqueueDelayedRunService set a run to `PENDING` when the `delay` has elapsed

When the run attempt gets created it will be marked as `EXECUTING`.

[EnqueueDelayedRunService.#call()](/apps/webapp/app/v3/services/enqueueDelayedRun.server.ts#41)

## 8. FinalizeTaskRunService finalizing a run

This service is called from many places, when a run is in a "final" state. This means the run can't be acted on anymore.

We set the status, expiredAt and completedAt fields.

[FinalizeTaskRunService.#call()](/apps/webapp/app/v3/services/finalizeTaskRun.server.ts#63)

This function is called from:

- [`FailedTaskRunService` when a run has SYSTEM_FAILURE](/apps/webapp/app/v3/failedTaskRun.server.ts#41)
- [`CancelAttemptService` when an attempt is canceled](/apps/webapp/app/v3/services/cancelAttempt.server.ts#66)
- [`CancelTaskRunService` when a run is canceled](/apps/webapp/app/v3/services/cancelTaskRun.server.ts#51)
- `CompleteAttemptService` when a SYSTEM_FAILURE happens
  - [No attempt](/apps/webapp/app/v3/services/completeAttempt.server.ts#74)
  - [`completeAttemptFailed` and there's no checkpoint](/apps/webapp/app/v3/services/completeAttempt.server.ts#280)
  - [`completeAttemptFailed` and the error is internal and a graceful exit timeout](/apps/webapp/app/v3/services/completeAttempt.server.ts#321)
- `CompleteTaskRunService` when a run has failed (this isn't a bug)
  - [`completeAttemptFailed`](/apps/webapp/app/v3/services/completeAttempt.server.ts#352)
- `CompleteTaskRunService` when a run is completed successfully
  - [`completeAttemptSuccessfully`](/apps/webapp/app/v3/services/completeAttempt.server.ts#135)
- `CrashTaskRunService` when a run has crashed
  - [`call`](/apps/webapp/app/v3/services/crashTaskRun.server.ts#47)
- `ExpireEnqueuedRunService` when a run has expired
  - [`call`](/apps/webapp/app/v3/services/expireEnqueuedRun.server.ts#42)

## 9. RescheduleTaskRunService (when further delaying a delayed run)

[RescheduleTaskRunService.#call()](/apps/webapp/app/v3/services/rescheduleTaskRun.server.ts#21)

## 10. Triggering a scheduled run

Graphile Worker calls this function based on the schedule. We add the schedule data onto the run, and call `TriggerTaskService.call()`.

[TriggerScheduledRunService.#call()](/apps/webapp/app/v3/services/triggerScheduledTask.server.ts#131)
