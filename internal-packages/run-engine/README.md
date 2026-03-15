# Trigger.dev Run Engine

The Run Engine process runs from triggering, to executing, retrying, and completing them.

It is responsible for:

- Creating, updating, and completing runs as they progress.
- Operating the run queue, including handling concurrency.
- Heartbeats which detects stalled runs and attempts to automatically recover them.
- Registering checkpoints which enable pausing/resuming of runs.

## Glossary

- **Platform**: The main Trigger.dev API, dashboard, database. The Run Engine is part of the platform.
- **Worker group**: A group of workers that all pull from the same queue, e.g. "us-east-1", "my-self-hosted-workers".
  - **Worker**: A worker is a 'server' that connects to the platform and receives runs.
    - **Supervisor**: Pulls new runs from the queue, communicates with the platform, spins up new Deploy executors.
    - **Deploy container**: Container that comes from a specific deploy from a user's project.
      - **Run controller**: The code that manages running the task.
      - **Run executor**: The actual task running.

## Overview

```
                                                                                                     ╔═══════════════════════════════╗
                                                                                                     ║                               ║░
                                                                                                     ║         Run triggered         ║░
                                                                                                     ║                               ║░
                                                                                                     ╚═══════════════════════════════╝░
                                               ___             ___           _                        ░░░░░░░░░░░░░░░│░░░░░░░░░░░░░░░░░
                                              | _ \_  _ _ _   | __|_ _  __ _(_)_ _  ___                              │
                                           ╔══|   / || | ' \  | _|| ' \/ _` | | ' \/ -_)═════════════════════════════╬══════════════════════════════════════╗
                                           ║  |_|_\\_,_|_||_| |___|_||_\__, |_|_||_\___|                             │                                      ║
                                           ║                           |___/                                         │                                      ║
                                           ║                                                                         │                                      ║
                                           ║                       ┌────────────────────────────────────── Has delay/debounce?                              ║
                                           ║                       │                                                 │                                      ║
                                           ║                      Yes                                               No                                      ║
                                           ║                       │                                                 │                                      ║
                                           ║                       ▼                                                 ▼                                      ║
                                           ║       ╔═══════════════════════════════╗                 ╔═══════════════════════════════╗                      ║
                                           ║       ║                               ║      Delay/     ║                               ║                      ║
                                           ║       ║            DELAYED            ║◀────debounce────║          RUN_CREATED          ║                      ║
                                           ║       ║                               ║                 ║                               ║                      ║
                                           ║       ╚═══════════════════════════════╝                 ╚═══════════════════════════════╝                      ║
                                           ║                       │                                                 │                                      ║
                                           ║                       │                                                 │                                      ║
                                           ║       +===============================+                         No delay/debounce                              ║
                                           ║       |                               |                                 │                                      ║
                                           ║       |         Redis Worker          |                                 │                                      ║
                                           ║       |                               |                                 ▼                                      ║
                                           ║       +===============================+                 ╔═══════════════════════════════╗                      ║
                                           ║                       │                                 ║                               ║                      ║
                                           ║                       └───────────After delay──────────▶║            QUEUED             ║◀────────────┐        ║
                                           ║                                                         ║                               ║             │        ║
                                           ║                                                         ╚═══════════════════════════════╝             │        ║
                                           ║                       ┌────All Waitpoints complete?─────┐               │                             │        ║
                                           ║                       │                                 │               │                             │        ║
                                           ║                       │                                 ▼               ▼                             │        ║
                                           ║       ╔═══════════════════════════════╗                 +===============================+             │        ║
                                           ║       ║                               ║                 |                               |        Slow retry    ║
                                           ║       ║           SUSPENDED           ║                 |           Run Queue           |             │        ║
                                           ║       ║                               ║                 |                               |             │        ║
                                           ║       ╚═══════════════════════════════╝                 +===============================+             │        ║
                        Run not executing  ║                       ▲                                                                               │        ║
                                           ║                       │                                                 │                             │        ║
       ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ╬ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ╬ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ╬ ═ ═ ═ ═║═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═ ═
                                           ║                       │                                                 │                             │        ║
                      Run maybe executing  ║                       │                                                                               │        ║    ╔═══════════════════════════════╗
                                           ║                       │                                                 │                             │        ║    ║                               ║░
                                           ║                       │                                       Pulled from the queue ◀─────────────────┼────────╬───◈║         Dequeue a run         ║░
                                           ║                       │                                                 │                             │        ║    ║                               ║░
                                           ║                       │                                                 ▼                             │        ║    ╚═══════════════════════════════╝░
                                           ║                       │                                 ╔═══════════════════════════════╗             │        ║     ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
                                           ║                       │                                 ║                               ║             │        ║
                                           ║                       │                                 ║       PENDING_EXECUTING       ║             │        ║
      ╔═══════════════════════════════╗    ║                       │                                 ║                               ║             │        ║
      ║                               ║░   ║                       │                                 ╚═══════════════════════════════╝             │        ║
      ║      Checkpoint created       ║◈───╬───────────────────────┤                                                 │                             │        ║    ╔═══════════════════════════════╗
      ║                               ║░   ║                                                                                                       │        ║    ║                               ║░
      ╚═══════════════════════════════╝░   ║                       │                                                 ├─────────────────────────────┼────────╬───◈║         Start attempt         ║░
       ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   ║                                                                         │                             │        ║    ║                               ║░
                                           ║                       │                                                 ▼                             │        ║    ╚═══════════════════════════════╝░
                                           ║                                               All            Is executing on worker                   │        ║     ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
                                           ║                       │               ┌────Waitpoints───┐               │               ┌─Quick retry │        ║
                                           ║                                       │    complete?    │               │               │      │      │        ║
                                           ║                       │               │                 ▼               ▼               ▼      │      │        ║
                                           ║       ╔═══════════════════════════════╗                 ╔═══════════════════════════════╗      │      │        ║
                                           ║       ║                               ║     Hits a      ║                               ║      │      │        ║
                                           ║       ║   EXECUTING_WITH_WAITPOINTS   ║◀───Waitpoint────║           EXECUTING           ║      │      │        ║
                                           ║       ║                               ║                 ║                               ║      │      │        ║
                                           ║       ╚═══════════════════════════════╝                 ╚═══════════════════════════════╝      │      │        ║
                                           ║                                                                         │                      │      │        ║    ╔═══════════════════════════════╗
                                           ║                                                                                                │      │        ║    ║                               ║░
                                           ║                                                                         ◀──────────────────────┼──────┼────────╬───◈║       Complete attempt        ║░
                                           ║                                                                         │                      │      │        ║    ║                               ║░
                                           ║                                                                         │                      │      │        ║    ╚═══════════════════════════════╝░
                                           ║                                                                         │                      │      │        ║     ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
                                           ║                                                                         ├───────────────▶ Attempt failed       ║
                                           ║                                                                         │                        │             ║
                                           ║                                                                  Attempt success                 │             ║
                                           ║                                                                         │                   All retries        ║
                                           ║                                                                         ▼                      used            ║
      ╔═══════════════════════════════╗    ║                                                         ╔═══════════════════════════════╗        │             ║
      ║                               ║░   ║                                                         ║                               ║        │             ║
      ║      User cancels a run       ║────╬──────────────▶  Is executing?  ─────────── No ─────────▶║           FINISHED            ║◀───────┘             ║
      ║                               ║░   ║                       │                                 ║                               ║                      ║
      ╚═══════════════════════════════╝░   ║                      Yes                                ╚═══════════════════════════════╝                      ║
       ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   ║                       │                                                 ▲                                      ║
                                           ║                       ▼                                                 │                                      ║
                                           ║       ╔═══════════════════════════════╗                                 │                                      ║
                                           ║       ║                               ║                                 │                                      ║
                                           ║       ║        PENDING_CANCEL         ║─────────────────────────────────┘                                      ║
                                           ║       ║                               ║                                                                        ║
                                           ║       ╚═══════════════════════════════╝                                                                        ║
                                           ║                                                                                                                ║
                                           ║                                                                                                                ║
                                           ║                                                                                                                ║
                                           ╚════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝

```

## Run locking

Many operations on the run are "atomic" in the sense that only a single operation can mutate them at a time. We use RedLock to create a distributed lock to ensure this. Postgres locking is not enough on its own because we have multiple API instances and Redis is used for the queue.

There are race conditions we need to deal with:

- When checkpointing the run continues to execute until the checkpoint has been stored. At the same time the run continues and the checkpoint can become irrelevant if the waitpoint is completed. Both can happen at the same time, so we must lock the run and protect against outdated checkpoints.

## Run execution

The execution state of a run is stored in the `TaskRunExecutionSnapshot` table in Postgres. This is separate from the `TaskRun` status which is exposed to users via the dashboard and API.

The `TaskRunExecutionSnapshot` `executionStatus` is used to determine the execution status and is internal to the run engine. It is a log of events that impact run execution – the data is used to execute the run.

A common pattern we use is to read the current state and check that the passed in `snapshotId` matches the current `snapshotId`. If it doesn't, we know that the state has moved on. In the case of a checkpoint coming in, we know we can just ignore it.

We can also store invalid states by setting an error. These invalid states are purely used for debugging and are ignored for execution purposes.

## Workers

A worker is a server that runs tasks.

In the dashboard under the "Regions" page, you can see all worker groups. You can set the default `region` there.

Then when triggering runs, you can override the `region` to use. The region is used internally to set the `masterQueue` that a run is placed in, this allows pulling runs only for that worker group.

## Pulling from the queue

A worker will call the Trigger.dev API with it's `region`. For dev environments, we will pass the `environment` id.

## Run Queue

This is a fair multi-tenant queue. It is designed to fairly select runs, respect concurrency limits, and have high throughput. It provides visibility into the current concurrency for the env, org, etc.

It has built-in reliability features:

- When nacking we increment the `attempt` and if it continually fails we will move it to a Dead Letter Queue (DLQ).
- If a run is in the DLQ you can redrive it.

## Heartbeats

Heartbeats are used to determine if a run has become stalled. Depending on the current execution status, we do different things. For example, if the run has been dequeued but the attempt hasn't been started we requeue it.

## Checkpoints

Checkpoints allow pausing an executing run and then resuming it later. This is an optimization to avoid wasted compute and is especially useful with "Waitpoints".

## Waitpoints

A "Waitpoint" is something that can block a run from continuing:

A single Waitpoint can block many runs, the same waitpoint can only block a run once (there's a unique constraint). They block run execution from continuing until all of them are completed.

They can have output data associated with them, e.g. the finished run payload. That includes an error, e.g. a failed run.

There are currently three types:

- `RUN` which gets completed when the associated run completes. Every run has an `associatedWaitpoint` that matches the lifetime of the run.
- `DATETIME` which gets completed when the datetime is reached.
- `MANUAL` which gets completed when that event occurs.

Waitpoints can have an idempotencyKey which allows stops them from being created multiple times. This is especially useful for event waitpoints, where you don't want to create a new waitpoint for the same event twice.

### `wait.for()` or `wait.until()`

Wait for a future time, then continue. We should add the option to pass an `idempotencyKey` so a second attempt doesn't wait again. By default it would wait again.

```ts
//Note if the idempotency key is a string, it will get prefixed with the run id.
//you can explicitly pass in an idempotency key created with the the global scope.
await wait.until(new Date("2022-01-01T00:00:00Z"), { idempotencyKey: "first-wait" });
await wait.until(new Date("2022-01-01T00:00:00Z"), { idempotencyKey: "second-wait" });
```

### `triggerAndWait()` or `batchTriggerAndWait()`

Trigger and then wait for run(s) to finish. If the run fails it will still continue but with the errors so the developer can decide what to do.

### The `trigger` `delay` option

When triggering a run and passing the `delay` option, we use a `DATETIME` waitpoint to block the run from starting.

### `wait.forRequest()`

Wait until a request has been received at the URL that you are given. This is useful for pausing a run and then continuing it again when some external event occurs on another service. For example, Replicate have an API where they will callback when their work is complete.

### `wait.forWaitpoint(waitpointId)`

A more advanced SDK which would require uses to explicitly create a waitpoint. We would also need `createWaitpoint()`, `completeWaitpoint()`, and `failWaitpoint()`.

```ts
// Your backend
import { wait } from "@trigger.dev/sdk";

type ApprovalToken = {
  status: "approved" | "rejected";
};

const waitpoint = await wait.createToken({ idempotencyKey: `purchase-${payload.cart.id}` });
const waitpoint = await wait.retrieveToken(waitpoint.id);

await wait.completeToken<ApprovalToken>(tokenId, {
  status: "approved",
});

// /trigger/approval.ts
export const approvalFlow = task({
  id: "approvalFlow",
  run: async (payload) => {
    //...do stuff

    // This must be called inside a task run function
    const result = await wait.forToken<ApprovalToken>(payload.tokenId);

    if (result.ok) {
      console.log("Token completed", result.output.status); // "approved" or "rejected"
    } else {
      console.log("Token timed out", result.error);
    }
    if (!result.ok) {
      //...timeout
    }

    //...do more stuff
  },
});
```

## Run flow control

There are several ways to control when a run will execute (or not). Each of these should be configurable on a task, a named queue that is shared between tasks, and at trigger time including the ability to pass a `key` so you can have per-tenant controls.

### Concurrency limits

When `trigger` is called the run is added to the queue. We only dequeue when the concurrency limit hasn't been exceeded for that task/queue.

### Debouncing

When `trigger` is called, we prevent too many runs happening in a period by collapsing into a single run. This is done by discarding some runs in a period.

This is useful:

- To prevent too many runs happening in a short period.

We should mark the run as `"DELAYED"` with the correct `delayUntil` time. This will allow the user to see that the run is delayed and why.

## Emitting events

The Run Engine emits events using its `eventBus`. This is used for runs completing, failing, or things that any workers should be aware of.

# RunEngine System Architecture

The RunEngine is composed of several specialized systems that handle different aspects of task execution and management. Below is a diagram showing the relationships between these systems.

```mermaid
graph TD
    RE[RunEngine]
    DS[DequeueSystem]
    RAS[RunAttemptSystem]
    ESS[ExecutionSnapshotSystem]
    WS[WaitpointSystem]
    BS[BatchSystem]
    ES[EnqueueSystem]
    CS[CheckpointSystem]
    DRS[DelayedRunSystem]
    TS[TtlSystem]
    WFS[WaitingForWorkerSystem]

    %% Core Dependencies
    RE --> DS
    RE --> RAS
    RE --> ESS
    RE --> WS
    RE --> BS
    RE --> ES
    RE --> CS
    RE --> DRS
    RE --> TS
    RE --> WFS

    %% System Dependencies
    DS --> ESS
    DS --> RAS

    RAS --> ESS
    RAS --> WS
    RAS --> BS

    WS --> ESS
    WS --> ES

    ES --> ESS

    CS --> ESS
    CS --> ES

    DRS --> ES

    WFS --> ES

    TS --> WS

    %% Shared Resources
    subgraph Resources
        PRI[(Prisma)]
        LOG[Logger]
        TRC[Tracer]
        RQ[RunQueue]
        RL[RunLocker]
        EB[EventBus]
        WRK[Worker]
        RCQ[ReleaseConcurrencyQueue]
    end

    %% Resource Dependencies
    RE -.-> Resources
    DS & RAS & ESS & WS & BS & ES & CS & DRS & TS & WFS -.-> Resources
```

## System Responsibilities

### DequeueSystem

- Handles dequeuing of tasks from master queues
- Manages resource allocation and constraints
- Handles task deployment verification

### RunAttemptSystem

- Manages run attempt lifecycle
- Handles success/failure scenarios
- Manages retries and cancellations
- Coordinates with other systems for run completion

### ExecutionSnapshotSystem

- Creates and manages execution snapshots
- Tracks run state and progress
- Manages heartbeats for active runs
- Maintains execution history

### WaitpointSystem

- Manages waitpoints for task synchronization
- Handles waitpoint completion
- Coordinates blocked runs
- Manages concurrency release

### BatchSystem

- Manages batch operations
- Handles batch completion
- Coordinates batch-related task runs

### EnqueueSystem

- Handles enqueueing of runs
- Manages run scheduling
- Coordinates with execution snapshots

## Shared Resources

- **Prisma**: Database access
- **Logger**: Logging functionality
- **Tracer**: Tracing and monitoring
- **RunQueue**: Task queue management
- **RunLocker**: Run locking mechanism
- **EventBus**: Event communication
- **Worker**: Background task execution
- **ReleaseConcurrencyQueue**: Manages concurrency token release

## Key Interactions

1. **RunEngine** orchestrates all systems and manages shared resources
2. **DequeueSystem** works with **RunAttemptSystem** for task execution
3. **RunAttemptSystem** coordinates with **WaitpointSystem** and **BatchSystem**
4. **WaitpointSystem** uses **EnqueueSystem** for run scheduling
5. **ExecutionSnapshotSystem** is used by all other systems to track state
6. All systems share common resources through the `SystemResources` interface
