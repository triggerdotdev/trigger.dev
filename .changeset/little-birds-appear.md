---
"@trigger.dev/sdk": patch
---

Removes the `releaseConcurrencyOnWaitpoint` option on queues and the `releaseConcurrency` option on various wait functions. Replaced with the following default behavior:

- Concurrency is never released when a run is first blocked via a waitpoint, at either the env or queue level.
- Concurrency is always released when a run is checkpointed and shutdown, at both the env and queue level.

Additionally, environment concurrency limits now have a new "Burst Factor", defaulting to 2.0x. The "Burst Factor" allows the environment-wide concurrency limit to be higher than any individual queue's concurrency limit. For example, if you have an environment concurrency limit of 100, and a Burst Factor of 2.0x, then you can execute up to 200 runs concurrently, but any one task/queue can still only execute 100 runs concurrently.

We've done some work cleaning up the run statuses. The new statuses are:

- `PENDING_VERSION`: Task is waiting for a version update because it cannot execute without additional information (task, queue, etc.)
- `QUEUED`: Task is waiting to be executed by a worker
- `DEQUEUED`: Task has been dequeued and is being sent to a worker to start executing.
- `EXECUTING`: Task is currently being executed by a worker
- `WAITING`: Task has been paused by the system, and will be resumed by the system
- `COMPLETED`: Task has been completed successfully
- `CANCELED`: Task has been canceled by the user
- `FAILED`: Task has failed to complete, due to an error in the system
- `CRASHED`: Task has crashed and won't be retried, most likely the worker ran out of resources, e.g. memory or storage
- `SYSTEM_FAILURE`: Task has failed to complete, due to an error in the system
- `DELAYED`: Task has been scheduled to run at a specific time
- `EXPIRED`: Task has expired and won't be executed
- `TIMED_OUT`: Task has reached it's maxDuration and has been stopped

We've removed the following statuses:

- `WAITING_FOR_DEPLOY`: This is no longer used, and is replaced by `PENDING_VERSION`
- `FROZEN`: This is no longer used, and is replaced by `WAITING`
- `INTERRUPTED`: This is no longer used
- `REATTEMPTING`: This is no longer used, and is replaced by `EXECUTING`

We've also added "boolean" helpers to runs returned via the API and from Realtime:

- `isQueued`: Returns true when the status is `QUEUED`, `PENDING_VERSION`, or `DELAYED`
- `isExecuting`: Returns true when the status is `EXECUTING`, `DEQUEUED`. These count against your concurrency limits.
- `isWaiting`: Returns true when the status is `WAITING`. These do not count against your concurrency limits.
- `isCompleted`: Returns true when the status is any of the completed statuses.
- `isCanceled`: Returns true when the status is `CANCELED`
- `isFailed`: Returns true when the status is any of the failed statuses.
- `isSuccess`: Returns true when the status is `COMPLETED`

This change adds the ability to easily detect which runs are being counted against your concurrency limit by filtering for both `EXECUTING` or `DEQUEUED`.
