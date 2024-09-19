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

### Run Queue

This is used to queue, dequeue, and manage concurrency. It also provides visibility into the concurrency for the env, org, etc.

Run IDs are enqueued. They're pulled from the queue in a fair way with advanced options for debouncing and visibility.

### Heartbeats

Heartbeats are used to determine if a run has stopped responding. If a heartbeat isn't received within a defined period then the run is judged to have become stuck and the attempt is failed.

### Checkpoints

Checkpoints allow pausing an executing run and then resuming it later.

## How does it work?

It's very important that a run can only be acted on by one process at a time. We lock runs using RedLock while they're being mutated. This prevents some network-related race conditions like the timing of checkpoints and heartbeats permanently hanging runs.

# Legacy system

These are all the TaskRun mutations happening right now:

## 1. Trigger

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
