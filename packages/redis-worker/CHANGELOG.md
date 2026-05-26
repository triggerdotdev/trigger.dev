# @trigger.dev/redis-worker

## 4.5.0-rc.2

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.5.0-rc.2`

## 4.5.0-rc.1

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.5.0-rc.1`

## 4.5.0-rc.0

### Patch Changes

- Add MollifierBuffer and MollifierDrainer primitives for trigger burst smoothing. ([#3614](https://github.com/triggerdotdev/trigger.dev/pull/3614))

  MollifierBuffer (`accept`, `pop`, `ack`, `requeue`, `fail`, `evaluateTrip`) is a per-env FIFO over Redis with atomic Lua transitions for status tracking. `evaluateTrip` is a sliding-window trip evaluator the webapp gate uses to detect per-env trigger bursts.

  MollifierDrainer pops entries through a polling loop with a user-supplied handler. The loop survives transient Redis errors via capped exponential backoff (up to 5s), and per-env pop failures don't poison the rest of the batch — one env's blip is logged and counted as failed for that tick. Rotation is two-level: orgs at the top, envs within each org. The buffer maintains `mollifier:orgs` and `mollifier:org-envs:${orgId}` atomically with per-env queues, so the drainer walks orgs → envs directly without an in-memory cache. The `maxOrgsPerTick` option (default 500) caps how many orgs are scheduled per tick; for each picked org, one env is popped (rotating round-robin within the org). An org with N envs gets the same per-tick scheduling slot as an org with 1 env, so tenant-level drainage throughput is determined by org count rather than env count.

- Updated dependencies:
  - `@trigger.dev/core@4.5.0-rc.0`

## 4.4.6

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.4.6`

## 4.4.5

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.4.5`

## 4.4.4

### Patch Changes

- Adapted the CLI API client to propagate the trigger source via http headers. ([#3241](https://github.com/triggerdotdev/trigger.dev/pull/3241))
- Updated dependencies:
  - `@trigger.dev/core@4.4.4`

## 4.4.3

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.4.3`

## 4.4.2

### Patch Changes

- Fix slow batch queue processing by removing spurious cooloff on concurrency blocks and fixing a race condition where retry attempt counts were not atomically updated during message re-queue. ([#3079](https://github.com/triggerdotdev/trigger.dev/pull/3079))
- Updated dependencies:
  - `@trigger.dev/core@4.4.2`

## 4.4.1

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.4.1`

## 4.4.0

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.4.0`

## 4.3.3

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.3.3`

## 4.3.2

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.3.2`

## 4.3.1

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.3.1`

## 4.3.0

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.3.0`

## 4.2.0

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.2.0`

## 4.1.2

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.1.2`

## 4.1.1

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.1.1`

## 4.1.0

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.1.0`

## 4.0.7

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.7`

## 4.0.6

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.6`

## 4.0.5

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.5`

## 4.0.4

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.4`

## 4.0.3

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.3`

## 4.0.2

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.2`

## 4.0.1

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.1`

## 4.0.0

### Major Changes

- Trigger.dev v4 release. Please see our upgrade to v4 docs to view the full changelog: https://trigger.dev/docs/upgrade-to-v4 ([#1869](https://github.com/triggerdotdev/trigger.dev/pull/1869))

### Patch Changes

- Now each worker gets it's own pLimit concurrency limiter, and we will only ever dequeue items where there is concurrency capacity, preventing incorrectly retried jobs due to visibility timeout expiry ([#2235](https://github.com/triggerdotdev/trigger.dev/pull/2235))
- Updated dependencies:
  - `@trigger.dev/core@4.0.0`

## 4.0.0-v4-beta.28

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.28`

## 4.0.0-v4-beta.27

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.27`

## 4.0.0-v4-beta.26

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.26`

## 4.0.0-v4-beta.25

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.25`

## 4.0.0-v4-beta.24

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.24`

## 4.0.0-v4-beta.23

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.23`

## 4.0.0-v4-beta.22

### Patch Changes

- Now each worker gets it's own pLimit concurrency limiter, and we will only ever dequeue items where there is concurrency capacity, preventing incorrectly retried jobs due to visibility timeout expiry ([#2235](https://github.com/triggerdotdev/trigger.dev/pull/2235))
- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.22`

## 4.0.0-v4-beta.21

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.21`

## 4.0.0-v4-beta.20

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.20`

## 4.0.0-v4-beta.19

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.19`

## 4.0.0-v4-beta.18

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.18`

## 4.0.0-v4-beta.17

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.17`

## 4.0.0-v4-beta.16

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.16`

## 4.0.0-v4-beta.15

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.15`

## 4.0.0-v4-beta.14

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.14`

## 4.0.0-v4-beta.13

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.13`

## 4.0.0-v4-beta.12

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.12`

## 4.0.0-v4-beta.11

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.11`

## 4.0.0-v4-beta.10

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.10`

## 4.0.0-v4-beta.9

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.9`

## 4.0.0-v4-beta.8

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.8`

## 4.0.0-v4-beta.7

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.7`

## 4.0.0-v4-beta.6

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.6`

## 4.0.0-v4-beta.5

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.5`

## 4.0.0-v4-beta.4

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.4`

## 4.0.0-v4-beta.3

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.3`

## 4.0.0-v4-beta.2

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.2`

## 4.0.0-v4-beta.1

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.1`

## 4.0.0-v4-beta.0

### Major Changes

- Trigger.dev v4 release. Please see our upgrade to v4 docs to view the full changelog: https://trigger.dev/docs/upgrade-to-v4 ([#1869](https://github.com/triggerdotdev/trigger.dev/pull/1869))

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.0`
