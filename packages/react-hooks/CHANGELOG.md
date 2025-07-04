# @trigger.dev/react-hooks

## 4.0.0-v4-beta.22

### Patch Changes

- Added the ability to specify a "createdAt" filter when subscribing to tags in our useRealtime hooks: ([#2158](https://github.com/triggerdotdev/trigger.dev/pull/2158))

  ```tsx
  // Only subscribe to runs created in the last 10 hours
  useRealtimeRunWithTags("my-tag", { createdAt: "10h" });
  ```

  You can also now choose to skip subscribing to specific columns by specifying the `skipColumns` option:

  ```tsx
  useRealtimeRun(run.id, { skipColumns: ["usageDurationMs"] });
  ```

- Fixes an issue with realtime when re-subscribing to a run, that would temporarily display stale data and the changes. Now when re-subscribing to a run only the latest changes will be vended ([#2162](https://github.com/triggerdotdev/trigger.dev/pull/2162))
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

- Run Engine 2.0 (alpha) ([#1575](https://github.com/triggerdotdev/trigger.dev/pull/1575))
- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.0`

## 3.3.17

### Patch Changes

- Add support for two-phase deployments and task version pinning ([#1739](https://github.com/triggerdotdev/trigger.dev/pull/1739))
- Updated dependencies:
  - `@trigger.dev/core@3.3.17`

## 3.3.16

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.16`

## 3.3.15

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.15`

## 3.3.14

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.14`

## 3.3.13

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.13`

## 3.3.12

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.12`

## 3.3.11

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.11`

## 3.3.10

### Patch Changes

- Make sure useRealtimeRun onComplete hook fires at the correct time ([#1599](https://github.com/triggerdotdev/trigger.dev/pull/1599))
- Handle errors thrown by requests in Realtime react hooks ([#1599](https://github.com/triggerdotdev/trigger.dev/pull/1599))
- Updated dependencies:
  - `@trigger.dev/core@3.3.10`

## 3.3.9

### Patch Changes

- Adding ability to update parent run metadata from child runs/tasks ([#1563](https://github.com/triggerdotdev/trigger.dev/pull/1563))
- Updated dependencies:
  - `@trigger.dev/core@3.3.9`

## 3.3.8

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.8`

## 3.3.7

### Patch Changes

- Now compatible with React 19 ([#1559](https://github.com/triggerdotdev/trigger.dev/pull/1559))
- - Fixes an issue in streams where "chunks" could get split across multiple reads ([#1549](https://github.com/triggerdotdev/trigger.dev/pull/1549))
  - Fixed stopping the run subscription after a run is finished, when using useRealtimeRun or useRealtimeRunWithStreams
  - Added an `onComplete` callback to `useRealtimeRun` and `useRealtimeRunWithStreams`
  - Optimized the run subscription to reduce unnecessary updates
- Updated dependencies:
  - `@trigger.dev/core@3.3.7`

## 3.3.6

### Patch Changes

- Realtime streams now powered by electric. Also, this change fixes a realtime bug that was causing too many re-renders, even on records that didn't change ([#1541](https://github.com/triggerdotdev/trigger.dev/pull/1541))
- Updated dependencies:
  - `@trigger.dev/core@3.3.6`

## 3.3.5

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.5`

## 3.3.4

### Patch Changes

- Add trigger options to all trigger hooks ([#1528](https://github.com/triggerdotdev/trigger.dev/pull/1528))
- Updated dependencies:
  - `@trigger.dev/core@3.3.4`

## 3.3.3

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.3`

## 3.3.2

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.2`

## 3.3.1

### Patch Changes

- Public access token scopes with just tags or just a batch can now access runs that have those tags or are in the batch. Previously, the only way to access a run was to have a specific scope for that exact run. ([#1511](https://github.com/triggerdotdev/trigger.dev/pull/1511))
- Updated dependencies:
  - `@trigger.dev/core@3.3.1`

## 3.3.0

### Minor Changes

- Improved Batch Triggering: ([#1502](https://github.com/triggerdotdev/trigger.dev/pull/1502))

  - The new Batch Trigger endpoint is now asynchronous and supports up to 500 runs per request.
  - The new endpoint also supports triggering multiple different tasks in a single batch request (support in the SDK coming soon).
  - The existing `batchTrigger` method now supports the new endpoint, and shouldn't require any changes to your code.

  - Idempotency keys now expire after 24 hours, and you can customize the expiration time when creating a new key by using the `idempotencyKeyTTL` parameter:

  ```ts
  await myTask.batchTrigger([{ payload: { foo: "bar" } }], {
    idempotencyKey: "my-key",
    idempotencyKeyTTL: "60s",
  });
  // Works for individual items as well:
  await myTask.batchTrigger([
    { payload: { foo: "bar" }, options: { idempotencyKey: "my-key", idempotencyKeyTTL: "60s" } },
  ]);
  // And `trigger`:
  await myTask.trigger({ foo: "bar" }, { idempotencyKey: "my-key", idempotencyKeyTTL: "60s" });
  ```

  ### Breaking Changes

  - We've removed the `idempotencyKey` option from `triggerAndWait` and `batchTriggerAndWait`, because it can lead to permanently frozen runs in deployed tasks. We're working on upgrading our entire system to support idempotency keys on these methods, and we'll re-add the option once that's complete.

### Patch Changes

- Added ability to subscribe to a batch of runs using runs.subscribeToBatch ([#1502](https://github.com/triggerdotdev/trigger.dev/pull/1502))
- Updated dependencies:
  - `@trigger.dev/core@3.3.0`

## 3.2.2

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.2.2`

## 3.2.1

### Patch Changes

- React hooks now all accept accessToken and baseURL options so the use of the Provider is no longer necessary ([#1486](https://github.com/triggerdotdev/trigger.dev/pull/1486))
- Upgrade zod to latest (3.23.8) ([#1484](https://github.com/triggerdotdev/trigger.dev/pull/1484))
- Realtime streams ([#1470](https://github.com/triggerdotdev/trigger.dev/pull/1470))
- Updated dependencies:
  - `@trigger.dev/core@3.2.1`

## 3.2.0

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.2.0`

## 3.1.2

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.1.2`

## 3.1.1

### Patch Changes

- useBatch renamed to useRealtimeBatch ([#1447](https://github.com/triggerdotdev/trigger.dev/pull/1447))
- Updated dependencies:
  - `@trigger.dev/core@3.1.1`

## 3.1.0

### Minor Changes

- Access run status updates in realtime, from your server or from your frontend ([#1402](https://github.com/triggerdotdev/trigger.dev/pull/1402))

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.1.0`
