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
