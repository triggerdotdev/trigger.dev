# Trigger.dev Run Engine

The Run Engine process runs from triggering, to executing, retrying, and completing them.

It is responsible for:

- Creating, updating, and completing runs as they progress.
- Operating the run queue, including handling concurrency.
- Heartbeats which detects stalled runs and attempts to automatically recover them.
- Registering checkpoints which enable pausing/resuming of runs.

## Run locking

Many operations on the run are "atomic" in the sense that only a single operation can mutate them at a time. We use RedLock to create a distributed lock to ensure this. Postgres locking is not enough on its own because we have multiple API instances and Redis is used for the queue.

There are race conditions we need to deal with:
- When checkpointing the run continues to execute until the checkpoint has been stored. At the same time the run continues and the checkpoint can become irrelevant if the waitpoint is completed. Both can happen at the same time, so we must lock the run and protect against outdated checkpoints.

## Run execution

The execution state of a run is stored in the `TaskRunExecutionSnapshot` table in Postgres. This is separate from the `TaskRun` status which is exposed to users via the dashboard and API.

![The execution states](./execution-states.png)

The `TaskRunExecutionSnapshot` `executionStatus` is used to determine the execution status and is internal to the run engine. It is a log of events that impact run execution – the data is used to execute the run.

A common pattern we use is to read the current state and check that the passed in `snapshotId` matches the current `snapshotId`. If it doesn't, we know that the state has moved on. In the case of a checkpoint coming in, we know we can just ignore it.

We can also store invalid states by setting an error. These invalid states are purely used for debugging and are ignored for execution purposes.

## Workers

A worker is a server that runs tasks. There are two types of workers:
- Hosted workers (serverless, managed and cloud-only)
- Self-hosted workers

In the dashboard under the "Workers" page, you can see all worker groups including the "main" group which is the default and not self-hosted. You can also see alternative worker groups that are available to you, such as "EU", "v3.2 (beta)", and any self-hosted worker groups you have created.

You add a new self-hosted worker group by clicking "Add" and choosing an `id` that is unique to your project.

Then when triggering runs, you can specify the `workerGroup` to use. It defaults to "main". The workerGroup is used internally to set the `masterQueue` that a run is placed in, this allows pulling runs only for that worker group.

On the "Workers" page, you can see the status of each worker group, including the number of workers in the group, the number of runs that are queued.

## Pulling from the queue

A worker will call the Trigger.dev API with it's `workerGroup`.

For warm starts, self-hosted workers we will also pass the `BackgroundWorker` id and `environment` id. This allow pulling relevant runs.

For dev environments, we will pass the `environment` id.

If there's only a `workerGroup`, we can just `dequeueFromMasterQueue()` to get runs. If there's a `BackgroundWorker` id, we need to determine if that `BackgroundWorker` is the latest. If it's the latest we call `dequeueFromEnvironmentMasterQueue()` to get any runs that aren't locked to a version. If it's not the latest, we call `dequeueFromBackgroundWorkerMasterQueue()` to get runs that are locked to that version.

### Run Queue

This is a fair multi-tenant queue. It is designed to fairly select runs, respect concurrency limits, and have high throughput. It provides visibility into the current concurrency for the env, org, etc.

It has built-in reliability features:
- When nacking we increment the `attempt` and if it continually fails we will move it to a Dead Letter Queue (DLQ).
- If a run is in the DLQ you can redrive it.

### Heartbeats

Heartbeats are used to determine if a run has become stalled. Depending on the current execution status, we do different things. For example, if the run has been dequeued but the attempt hasn't been started we requeue it.

### Checkpoints

Checkpoints allow pausing an executing run and then resuming it later. This is an optimization to avoid wasted compute and is especially useful with "Waitpoints".

## Waitpoints

A "Waitpoint" is something that can block a run from continuing:

A single Waitpoint can block many runs, the same waitpoint can only block a run once (there's a unique constraint). They block run execution from continuing until all of them are completed.

They can have output data associated with them, e.g. the finished run payload. That includes an error, e.g. a failed run.

There are currently three types:
  - `RUN` which gets completed when the associated run completes. Every run has an `associatedWaitpoint` that matches the lifetime of the run.
  - `DATETIME` which gets completed when the datetime is reached.
  - `EVENT` which gets completed when that event occurs.

Waitpoints can have an idempotencyKey which allows stops them from being created multiple times. This is especially useful for event waitpoints, where you don't want to create a new waitpoint for the same event twice.

### Use cases

#### `wait.for()` or `wait.until()`
Wait for a future time, then continue. We should add the option to pass an `idempotencyKey` so a second attempt doesn't wait again. By default it would wait again.

#### `triggerAndWait()` or `batchTriggerAndWait()`
Trigger and then wait for run(s) to finish. If the run fails it will still continue but with the errors so the developer can decide what to do.

### The `trigger` `delay` option

When triggering a run and passing the `delay` option, we use a `DATETIME` waitpoint to block the run from starting.

#### `wait.forRequest()`
Wait until a request has been received at the URL that you are given. This is useful for pausing a run and then continuing it again when some external event occurs on another service. For example, Replicate have an API where they will callback when their work is complete.

#### `wait.forWaitpoint(waitpointId)`

A more advanced SDK which would require uses to explicitly create a waitpoint. We would also need `createWaitpoint()`, `completeWaitpoint()`, and `failWaitpoint()`.

#### `wait.forRunToComplete(runId)`

You could wait for another run (or runs) using their run ids. This would allow you to wait for runs that you haven't triggered inside that run.

#### Debouncing

Using a `DateTime` waitpoint and an `idempotencyKey` debounce can be implemented.

Suggested usage:

```ts
await myTask.trigger(
  { some: "data" },
  { debounce: { key: user.id, wait: "30s", maxWait: "2m", leading: true } }
);
```

Implementation:

The Waitpoint  `idempotencyKey` should be prefixed like `debounce-${debounce.key}`. Also probably with the `taskIdentifier`?

1. When trigger is called with `debounce`, we check if there's an active waitpoint with the relevant `idempotencyKey`.
2. If `leading` is false (default):
   - If there's a waiting run: update its payload and extend the waitpoint's completionTime
   - If no waiting run: create a new run and DATETIME waitpoint
3. If `leading` is true:
   - If there is no pending waitpoint: execute immediately but create a waitpoint with the idempotencyKey.
   - If there is a pending waitpoint
     - If there's a blocked run already, update the payload and extend the `completionTime`.
     - If there's not a blocked run, create the run and block it with the waitpoint.
4. If `maxWait` is specified:
   - The waitpoint's completionTime is capped at the waitpoint `createdAt` + maxWait.
   - Ensures execution happens even during constant triggering
5. When the waitpoint is completed we need to clear the `idempotencyKey`. To clear an `idempotencyKey`, move the original value to the `inactiveIdempotencyKey` column and set the main one to a new randomly generated one.

//todo implement auto-deactivating of the idempotencyKey when the waitpoint is completed. This would make it easier to implement features like this.

#### Rate limiting

Both when triggering tasks and also any helpers we wanted inside the task.

For inside tasks, we could use the DATETIME waitpoints. Or it might be easier to use an existing rate limiting library with Redis and receive notifications when a limit is cleared and complete associated waitpoints.

## Emitting events

The Run Engine emits events using its `eventBus`. This is used for runs completing, failing, or things that any workers should be aware of.

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
