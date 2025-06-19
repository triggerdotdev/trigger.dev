# @trigger.dev/sdk

## 4.0.0-v4-beta.22

### Patch Changes

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

- Improve metadata flushing efficiency by collapsing operations ([#2106](https://github.com/triggerdotdev/trigger.dev/pull/2106))
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

- When you create a Waitpoint token using `wait.createToken()` you get a URL back that can be used to complete it by making an HTTP POST request. ([#2025](https://github.com/triggerdotdev/trigger.dev/pull/2025))
- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.14`

## 4.0.0-v4-beta.13

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.13`

## 4.0.0-v4-beta.12

### Patch Changes

- Display clickable links in Cursor terminal ([#1998](https://github.com/triggerdotdev/trigger.dev/pull/1998))
- Add onCancel lifecycle hook ([#2022](https://github.com/triggerdotdev/trigger.dev/pull/2022))
- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.12`

## 4.0.0-v4-beta.11

### Patch Changes

- Fixed an issue with realtime streams that timeout and resume streaming dropping chunks ([#1993](https://github.com/triggerdotdev/trigger.dev/pull/1993))
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

- Fix issue where realtime streams would cut off after 5 minutes ([#1952](https://github.com/triggerdotdev/trigger.dev/pull/1952))
- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.6`

## 4.0.0-v4-beta.5

### Patch Changes

- The envvars.list() and retrieve() functions receive isSecret for each value. Secret values are always redacted. ([#1942](https://github.com/triggerdotdev/trigger.dev/pull/1942))
- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.5`

## 4.0.0-v4-beta.4

### Patch Changes

- maintain proper context in metadata.root and parent getters ([#1917](https://github.com/triggerdotdev/trigger.dev/pull/1917))
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
- Deprecate toolTask and replace with `ai.tool(mySchemaTask)` ([#1863](https://github.com/triggerdotdev/trigger.dev/pull/1863))
- v4: New lifecycle hooks ([#1817](https://github.com/triggerdotdev/trigger.dev/pull/1817))
- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.0`

## 3.3.17

### Patch Changes

- Add support for two-phase deployments and task version pinning ([#1739](https://github.com/triggerdotdev/trigger.dev/pull/1739))
- Updated dependencies:
  - `@trigger.dev/core@3.3.17`

## 3.3.16

### Patch Changes

- You can add Alerts in the dashboard. One of these is a webhook, which this change greatly improves. ([#1703](https://github.com/triggerdotdev/trigger.dev/pull/1703))

  The main change is that there's now an SDK function to verify and parse them (similar to Stripe SDK).

  ```ts
  const event = await webhooks.constructEvent(request, process.env.ALERT_WEBHOOK_SECRET!);
  ```

  If the signature you provide matches the one from the dashboard when you create the webhook, you will get a nicely typed object back for these three types:

  - "alert.run.failed"
  - "alert.deployment.success"
  - "alert.deployment.failed"

- Updated dependencies:
  - `@trigger.dev/core@3.3.16`

## 3.3.15

### Patch Changes

- Detect ffmpeg OOM errors, added manual OutOfMemoryError ([#1694](https://github.com/triggerdotdev/trigger.dev/pull/1694))
- Updated dependencies:
  - `@trigger.dev/core@3.3.15`

## 3.3.14

### Patch Changes

- Added the ability to retry runs that fail with an Out Of Memory (OOM) error on a larger machine. ([#1691](https://github.com/triggerdotdev/trigger.dev/pull/1691))
- Updated dependencies:
  - `@trigger.dev/core@3.3.14`

## 3.3.13

### Patch Changes

- Fixed issue with asResponse and withResponse not working on runs.retrieve ([#1648](https://github.com/triggerdotdev/trigger.dev/pull/1648))
- Updated dependencies:
  - `@trigger.dev/core@3.3.13`

## 3.3.12

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.12`

## 3.3.11

### Patch Changes

- Add support for specifying machine preset at trigger time. Works with any trigger function: ([#1608](https://github.com/triggerdotdev/trigger.dev/pull/1608))

  ```ts
  // Same as usual, will use the machine preset on childTask, defaults to "small-1x"
  await childTask.trigger({ message: "Hello, world!" });

  // This will override the task's machine preset and any defaults. Works with all trigger functions.
  await childTask.trigger({ message: "Hello, world!" }, { machine: "small-2x" });
  await childTask.triggerAndWait({ message: "Hello, world!" }, { machine: "small-2x" });

  await childTask.batchTrigger([
    { payload: { message: "Hello, world!" }, options: { machine: "micro" } },
    { payload: { message: "Hello, world!" }, options: { machine: "large-1x" } },
  ]);
  await childTask.batchTriggerAndWait([
    { payload: { message: "Hello, world!" }, options: { machine: "micro" } },
    { payload: { message: "Hello, world!" }, options: { machine: "large-1x" } },
  ]);

  await tasks.trigger<typeof childTask>(
    "child",
    { message: "Hello, world!" },
    { machine: "small-2x" }
  );
  await tasks.batchTrigger<typeof childTask>("child", [
    { payload: { message: "Hello, world!" }, options: { machine: "micro" } },
    { payload: { message: "Hello, world!" }, options: { machine: "large-1x" } },
  ]);
  ```

- Updated dependencies:
  - `@trigger.dev/core@3.3.11`

## 3.3.10

### Patch Changes

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

- - Fixes an issue in streams where "chunks" could get split across multiple reads ([#1549](https://github.com/triggerdotdev/trigger.dev/pull/1549))
  - Fixed stopping the run subscription after a run is finished, when using useRealtimeRun or useRealtimeRunWithStreams
  - Added an `onComplete` callback to `useRealtimeRun` and `useRealtimeRunWithStreams`
  - Optimized the run subscription to reduce unnecessary updates
- Updated dependencies:
  - `@trigger.dev/core@3.3.7`

## 3.3.6

### Patch Changes

- Realtime streams now powered by electric. Also, this change fixes a realtime bug that was causing too many re-renders, even on records that didn't change ([#1541](https://github.com/triggerdotdev/trigger.dev/pull/1541))
- Add option to trigger batched items sequentially, and default to parallel triggering which is faster ([#1536](https://github.com/triggerdotdev/trigger.dev/pull/1536))
- Updated dependencies:
  - `@trigger.dev/core@3.3.6`

## 3.3.5

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.5`

## 3.3.4

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.4`

## 3.3.3

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.3`

## 3.3.2

### Patch Changes

- Add one-time use public tokens to trigger and batch trigger ([#1515](https://github.com/triggerdotdev/trigger.dev/pull/1515))
- Fix for waiting for realtime streams to finish ([#1520](https://github.com/triggerdotdev/trigger.dev/pull/1520))
- Updated dependencies:
  - `@trigger.dev/core@3.3.2`

## 3.3.1

### Patch Changes

- Fixed the missing icons in trigger spans ([#1506](https://github.com/triggerdotdev/trigger.dev/pull/1506))
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

- Added new batch.trigger and batch.triggerByTask methods that allows triggering multiple different tasks in a single batch: ([#1502](https://github.com/triggerdotdev/trigger.dev/pull/1502))

  ```ts
  import { batch } from "@trigger.dev/sdk/v3";
  import type { myTask1, myTask2 } from "./trigger/tasks";

  // Somewhere in your backend code
  const response = await batch.trigger<typeof myTask1 | typeof myTask2>([
    { id: "task1", payload: { foo: "bar" } },
    { id: "task2", payload: { baz: "qux" } },
  ]);

  for (const run of response.runs) {
    if (run.ok) {
      console.log(run.output);
    } else {
      console.error(run.error);
    }
  }
  ```

  Or if you are inside of a task, you can use `triggerByTask`:

  ```ts
  import { batch, task, runs } from "@trigger.dev/sdk/v3";

  export const myParentTask = task({
    id: "myParentTask",
    run: async () => {
      const response = await batch.triggerByTask([
        { task: myTask1, payload: { foo: "bar" } },
        { task: myTask2, payload: { baz: "qux" } },
      ]);

      const run1 = await runs.retrieve(response.runs[0]);
      console.log(run1.output); // typed as { foo: string }

      const run2 = await runs.retrieve(response.runs[1]);
      console.log(run2.output); // typed as { baz: string }

      const response2 = await batch.triggerByTaskAndWait([
        { task: myTask1, payload: { foo: "bar" } },
        { task: myTask2, payload: { baz: "qux" } },
      ]);

      if (response2.runs[0].ok) {
        console.log(response2.runs[0].output); // typed as { foo: string }
      }

      if (response2.runs[1].ok) {
        console.log(response2.runs[1].output); // typed as { baz: string }
      }
    },
  });

  export const myTask1 = task({
    id: "myTask1",
    run: async () => {
      return {
        foo: "bar",
      };
    },
  });

  export const myTask2 = task({
    id: "myTask2",
    run: async () => {
      return {
        baz: "qux",
      };
    },
  });
  ```

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

- Remove browser export condition - not necessary with the react-hooks package that uses core ([#1455](https://github.com/triggerdotdev/trigger.dev/pull/1455))
- Updated dependencies:
  - `@trigger.dev/core@3.1.1`

## 3.1.0

### Minor Changes

- Access run status updates in realtime, from your server or from your frontend ([#1402](https://github.com/triggerdotdev/trigger.dev/pull/1402))

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.1.0`

## 3.0.13

### Patch Changes

- README updates ([#1408](https://github.com/triggerdotdev/trigger.dev/pull/1408))
- Updated dependencies:
  - `@trigger.dev/core@3.0.13`

## 3.0.12

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.0.12`

## 3.0.11

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.0.11`

## 3.0.10

### Patch Changes

- Adding maxDuration to tasks to allow timing out runs after they exceed a certain number of seconds ([#1377](https://github.com/triggerdotdev/trigger.dev/pull/1377))
- Updated dependencies:
  - `@trigger.dev/core@3.0.10`

## 3.0.9

### Patch Changes

- Removed the inline-code accessory from the logs when calling trigger or batchTrigger from a run ([#1364](https://github.com/triggerdotdev/trigger.dev/pull/1364))
- Updated dependencies:
  - `@trigger.dev/core@3.0.9`

## 3.0.8

### Patch Changes

- Add Run metadata to allow for storing up to 4KB of data on a run and update it during the run ([#1357](https://github.com/triggerdotdev/trigger.dev/pull/1357))
- Updated dependencies:
  - `@trigger.dev/core@3.0.8`

## 3.0.7

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.0.7`

## 3.0.6

### Patch Changes

- e79f0cc84: runs.retrieve() now includes details about related runs (root, parent, and children) as well how how the runs were triggered and if they are in a batch
- Updated dependencies [4e0bc485a]
  - @trigger.dev/core@3.0.6

## 3.0.5

### Patch Changes

- @trigger.dev/core@3.0.5

## 3.0.4

### Patch Changes

- 4adc773c7: Auto-resolve payload/output presigned urls when retrieving a run with runs.retrieve
- Updated dependencies [4adc773c7]
  - @trigger.dev/core@3.0.4

## 3.0.3

### Patch Changes

- Updated dependencies [3d53d4c08]
  - @trigger.dev/core@3.0.3

## 3.0.2

### Patch Changes

- @trigger.dev/core@3.0.2

## 3.0.1

### Patch Changes

- 3aa581179: Fixing false-positive package version mismatches
- Updated dependencies [3aa581179]
  - @trigger.dev/core@3.0.1

## 3.0.0

### Major Changes

- cf13fbdf3: Release 3.0.0
- 395abe1b9: Updates to support Trigger.dev v3

### Patch Changes

- b66d5525e: add machine config and secure zod connection
- 9491a1649: Implement task.onSuccess/onFailure and config.onSuccess/onFailure
- b271742dc: Configurable log levels in the config file and via env var
- 0591db5f2: Fixes for continuing after waits
- f9ec66c56: New Build System
- 8cae1d087: Fix trigger functions for custom queues
- 3a1b0c486: v3: Environment variable management API and SDK, along with resolveEnvVars CLI hook
- 979bee50d: Fix return type of runs.retrieve, and allow passing the type of the task to runs.retrieve
- b68012f81: Make msw a normal dependency (for now) to fix Module Not Found error in Next.js.

  It turns out that webpack will "hoist" dynamically imported modules and attempt to resolve them at build time, even though it's an optional peer dep:

  https://x.com/maverickdotdev/status/1782465214308319404

- 203e00208: Add runs.retrieve management API method to get info about a run by run ID
- 1b90ffbb8: v3: Usage tracking
- 51bb4c887: Fix for calling trigger and passing a custom queue
- 4986bfda2: Export queue from the SDK
- 086a0f95c: Extract common trigger code into internal functions and add a tasks.batchTriggerAndWait function
- 4f95c9de4: v3: recover from server rate limiting errors in a more reliable way
- 0591db5f2: Rollback to try and fix some dependent attempt issues
- 8578c9b28: Support self-hosters pushing to a custom registry when running deploy
- 0e77e7ef7: v3: Trigger delayed runs and reschedule them
- ecf1110ab: v3: Export AbortTaskRunError from @trigger.dev/sdk/v3
- f854cb90e: Added replayRun function to the SDK
- 44e1b8754: Improve the SDK function types and expose a new APIError instead of the APIResult type
- 55264657d: You can now add tags to runs and list runs using them
- 6d9dfbc75: Add configure function to be able to configure the SDK manually
- ecef19966: Use global setTimeout to ensure cross-runtime support
- 719c0a0b9: Fixed incorrect span timings around checkpoints by implementing a precise wall clock that resets after restores
- 4986bfda2: Adding task with a triggerSource of schedule
- e9a63a486: Lock SDK and CLI deps on exact core version
- 374edef02: Updates the `trigger`, `batchTrigger` and their `*AndWait` variants to use the first parameter for the payload/items, and the second parameter for options.

  Before:

  ```ts
  await yourTask.trigger({ payload: { foo: "bar" }, options: { idempotencyKey: "key_1234" } });
  await yourTask.triggerAndWait({
    payload: { foo: "bar" },
    options: { idempotencyKey: "key_1234" },
  });

  await yourTask.batchTrigger({
    items: [{ payload: { foo: "bar" } }, { payload: { foo: "baz" } }],
  });
  await yourTask.batchTriggerAndWait({
    items: [{ payload: { foo: "bar" } }, { payload: { foo: "baz" } }],
  });
  ```

  After:

  ```ts
  await yourTask.trigger({ foo: "bar" }, { idempotencyKey: "key_1234" });
  await yourTask.triggerAndWait({ foo: "bar" }, { idempotencyKey: "key_1234" });

  await yourTask.batchTrigger([{ payload: { foo: "bar" } }, { payload: { foo: "baz" } }]);
  await yourTask.batchTriggerAndWait([{ payload: { foo: "bar" } }, { payload: { foo: "baz" } }]);
  ```

  We've also changed the API of the `triggerAndWait` result. Before, if the subtask that was triggered finished with an error, we would automatically "rethrow" the error in the parent task.

  Now instead we're returning a `TaskRunResult` object that allows you to discriminate between successful and failed runs in the subtask:

  Before:

  ```ts
  try {
    const result = await yourTask.triggerAndWait({ foo: "bar" });

    // result is the output of your task
    console.log("result", result);
  } catch (error) {
    // handle subtask errors here
  }
  ```

  After:

  ```ts
  const result = await yourTask.triggerAndWait({ foo: "bar" });

  if (result.ok) {
    console.log(`Run ${result.id} succeeded with output`, result.output);
  } else {
    console.log(`Run ${result.id} failed with error`, result.error);
  }
  ```

- 26093896d: When using idempotency keys, triggerAndWait and batchTriggerAndWait will still work even if the existing runs have already been completed (or even partially completed, in the case of batchTriggerAndWait)

  - TaskRunExecutionResult.id is now the run friendlyId, not the attempt friendlyId
  - A single TaskRun can now have many batchItems, in the case of batchTriggerAndWait while using idempotency keys
  - A run’s idempotencyKey is now added to the ctx as well as the TaskEvent and displayed in the span view
  - When resolving batchTriggerAndWait, the runtimes no longer reject promises, leading to an error in the parent task

- b68012f81: Move to our global system from AsyncLocalStorage for the current task context storage
- c9e1a3e9c: Remove unimplemented batchOptions
- cf13fbdf3: Add triggerAndWait().unwrap() to more easily get at the output or throw the subtask error
- 3f8b6d8fc: v2: Better handle recovering from platform communication errors by auto-yielding back to the platform in case of temporary API failures
- 1281d40e4: When a v2 run hits the rate limit, reschedule with the reset date
- ba71f959e: Management SDK overhaul and adding the runs.list API
- 7c36a1a4b: v3: Adding SDK functions for triggering tasks in a typesafe way, without importing task file
- f93eae300: Dynamically import superjson and fix some bundling issues
- c405ae711: Added timezone support to schedules
- 34ca7667d: v3: Include presigned urls for downloading large payloads and outputs when using runs.retrieve
- 8ba998794: Added declarative cron schedules
- f854cb90e: Added cancelRun to the SDK
- 4986bfda2: Added a new global - Task Catalog - to better handle task metadata
- b68012f81: Extracting out all the non-SDK related features from the main @trigger.dev/core/v3 export
- 8578c9b28: Remove msw and retry.interceptFetch
- Updated dependencies [ed2a26c86]
- Updated dependencies [c702d6a9c]
- Updated dependencies [9882d66f8]
- Updated dependencies [b66d5525e]
- Updated dependencies [e3db25739]
- Updated dependencies [9491a1649]
- Updated dependencies [1670c4c41]
- Updated dependencies [b271742dc]
- Updated dependencies [cf13fbdf3]
- Updated dependencies [dbda820a7]
- Updated dependencies [4986bfda2]
- Updated dependencies [eb6012628]
- Updated dependencies [f9ec66c56]
- Updated dependencies [f7d32b83b]
- Updated dependencies [09413a62a]
- Updated dependencies [3a1b0c486]
- Updated dependencies [203e00208]
- Updated dependencies [b4f9b70ae]
- Updated dependencies [1b90ffbb8]
- Updated dependencies [5cf90da72]
- Updated dependencies [9af2570da]
- Updated dependencies [7ea8532cc]
- Updated dependencies [1477a2e30]
- Updated dependencies [4f95c9de4]
- Updated dependencies [83dc87155]
- Updated dependencies [d490bc5cb]
- Updated dependencies [e3cf456c6]
- Updated dependencies [14c2bdf89]
- Updated dependencies [9491a1649]
- Updated dependencies [0ed93a748]
- Updated dependencies [8578c9b28]
- Updated dependencies [0e77e7ef7]
- Updated dependencies [e417aca87]
- Updated dependencies [568da0178]
- Updated dependencies [c738ef39c]
- Updated dependencies [ece6ca678]
- Updated dependencies [f854cb90e]
- Updated dependencies [0e919f56f]
- Updated dependencies [44e1b8754]
- Updated dependencies [55264657d]
- Updated dependencies [6d9dfbc75]
- Updated dependencies [e337b2165]
- Updated dependencies [719c0a0b9]
- Updated dependencies [4986bfda2]
- Updated dependencies [e30beb779]
- Updated dependencies [68d32429b]
- Updated dependencies [374edef02]
- Updated dependencies [e04d44866]
- Updated dependencies [26093896d]
- Updated dependencies [55d1f8c67]
- Updated dependencies [c405ae711]
- Updated dependencies [9e5382951]
- Updated dependencies [b68012f81]
- Updated dependencies [098932ea9]
- Updated dependencies [68d32429b]
- Updated dependencies [9835f4ec5]
- Updated dependencies [3f8b6d8fc]
- Updated dependencies [fde939a30]
- Updated dependencies [1281d40e4]
- Updated dependencies [ba71f959e]
- Updated dependencies [395abe1b9]
- Updated dependencies [03b104a3d]
- Updated dependencies [f93eae300]
- Updated dependencies [5ae3da6b4]
- Updated dependencies [c405ae711]
- Updated dependencies [34ca7667d]
- Updated dependencies [8ba998794]
- Updated dependencies [62c9a5b71]
- Updated dependencies [392453e8a]
- Updated dependencies [8578c9b28]
- Updated dependencies [6a379e4e9]
- Updated dependencies [f854cb90e]
- Updated dependencies [584c7da5d]
- Updated dependencies [4986bfda2]
- Updated dependencies [e69ffd314]
- Updated dependencies [b68012f81]
- Updated dependencies [39885a427]
- Updated dependencies [8578c9b28]
- Updated dependencies [e69ffd314]
- Updated dependencies [8578c9b28]
- Updated dependencies [f04041744]
- Updated dependencies [d934feb02]
  - @trigger.dev/core@3.0.0

## 3.0.0-beta.55

### Patch Changes

- 0591db5f2: Fixes for continuing after waits
  - @trigger.dev/core@3.0.0-beta.55
  - @trigger.dev/core-backend@3.0.0-beta.55

## 3.0.0-beta.54

### Patch Changes

- 728eeeff6: Rollback to try and fix some dependent attempt issues
  - @trigger.dev/core@3.0.0-beta.54
  - @trigger.dev/core-backend@3.0.0-beta.54

## 3.0.0-beta.53

### Patch Changes

- Updated dependencies [5cf90da72]
  - @trigger.dev/core@3.0.0-beta.53
  - @trigger.dev/core-backend@3.0.0-beta.53

## 3.0.0-beta.52

### Patch Changes

- 8cae1d087: Fix trigger functions for custom queues
- Updated dependencies [9882d66f8]
- Updated dependencies [09413a62a]
  - @trigger.dev/core@3.0.0-beta.52
  - @trigger.dev/core-backend@3.0.0-beta.52

## 3.0.0-beta.51

### Patch Changes

- 979bee50d: Fix return type of runs.retrieve, and allow passing the type of the task to runs.retrieve
- 086a0f95c: Extract common trigger code into internal functions and add a tasks.batchTriggerAndWait function
- 55264657d: You can now add tags to runs and list runs using them
- Updated dependencies [55264657d]
  - @trigger.dev/core@3.0.0-beta.51
  - @trigger.dev/core-backend@3.0.0-beta.51

## 3.0.0-beta.50

### Patch Changes

- 8ba998794: Added declarative cron schedules
- Updated dependencies [8ba998794]
  - @trigger.dev/core@3.0.0-beta.50
  - @trigger.dev/core-backend@3.0.0-beta.50

## 3.0.0-beta.49

### Patch Changes

- Updated dependencies [dbda820a7]
- Updated dependencies [e417aca87]
- Updated dependencies [d934feb02]
  - @trigger.dev/core@3.0.0-beta.49
  - @trigger.dev/core-backend@3.0.0-beta.49

## 3.0.0-beta.48

### Patch Changes

- ecf1110ab: v3: Export AbortTaskRunError from @trigger.dev/sdk/v3
  - @trigger.dev/core@3.0.0-beta.48
  - @trigger.dev/core-backend@3.0.0-beta.48

## 3.0.0-beta.47

### Patch Changes

- 4f95c9de4: v3: recover from server rate limiting errors in a more reliable way
- Updated dependencies [4f95c9de4]
- Updated dependencies [e04d44866]
  - @trigger.dev/core@3.0.0-beta.47
  - @trigger.dev/core-backend@3.0.0-beta.47

## 3.0.0-beta.46

### Patch Changes

- Updated dependencies [14c2bdf89]
  - @trigger.dev/core@3.0.0-beta.46
  - @trigger.dev/core-backend@3.0.0-beta.46

## 3.0.0-beta.45

### Patch Changes

- 0e77e7ef7: v3: Trigger delayed runs and reschedule them
- Updated dependencies [0e77e7ef7]
- Updated dependencies [568da0178]
- Updated dependencies [5ae3da6b4]
  - @trigger.dev/core@3.0.0-beta.45
  - @trigger.dev/core-backend@3.0.0-beta.45

## 3.0.0-beta.44

### Patch Changes

- Updated dependencies [39885a427]
  - @trigger.dev/core@3.0.0-beta.44
  - @trigger.dev/core-backend@3.0.0-beta.44

## 3.0.0-beta.43

### Patch Changes

- 34ca7667d: v3: Include presigned urls for downloading large payloads and outputs when using runs.retrieve
- Updated dependencies [34ca7667d]
  - @trigger.dev/core@3.0.0-beta.43
  - @trigger.dev/core-backend@3.0.0-beta.43

## 3.0.0-beta.42

### Patch Changes

- ecef19966: Use global setTimeout to ensure cross-runtime support
  - @trigger.dev/core@3.0.0-beta.42
  - @trigger.dev/core-backend@3.0.0-beta.42

## 3.0.0-beta.41

### Patch Changes

- 7c36a1a4b: v3: Adding SDK functions for triggering tasks in a typesafe way, without importing task file
  - @trigger.dev/core@3.0.0-beta.41
  - @trigger.dev/core-backend@3.0.0-beta.41

## 3.0.0-beta.40

### Patch Changes

- Updated dependencies [55d1f8c67]
- Updated dependencies [098932ea9]
- Updated dependencies [9835f4ec5]
  - @trigger.dev/core@3.0.0-beta.40
  - @trigger.dev/core-backend@3.0.0-beta.40

## 3.0.0-beta.39

### Patch Changes

- @trigger.dev/core@3.0.0-beta.39
- @trigger.dev/core-backend@3.0.0-beta.39

## 3.0.0-beta.38

### Patch Changes

- 1b90ffbb8: v3: Usage tracking
- c405ae711: Added timezone support to schedules
- Updated dependencies [1b90ffbb8]
- Updated dependencies [0ed93a748]
- Updated dependencies [c405ae711]
- Updated dependencies [c405ae711]
  - @trigger.dev/core@3.0.0-beta.38
  - @trigger.dev/core-backend@3.0.0-beta.38

## 3.0.0-beta.37

### Patch Changes

- Updated dependencies [68d32429b]
- Updated dependencies [68d32429b]
  - @trigger.dev/core@3.0.0-beta.37
  - @trigger.dev/core-backend@3.0.0-beta.37

## 3.0.0-beta.36

### Patch Changes

- 51bb4c887: Fix for calling trigger and passing a custom queue
- ba71f959e: Management SDK overhaul and adding the runs.list API
- Updated dependencies [b4f9b70ae]
- Updated dependencies [ba71f959e]
  - @trigger.dev/core@3.0.0-beta.36
  - @trigger.dev/core-backend@3.0.0-beta.36

## 3.0.0-beta.35

### Patch Changes

- Updated dependencies [ece6ca678]
- Updated dependencies [e69ffd314]
- Updated dependencies [e69ffd314]
  - @trigger.dev/core@3.0.0-beta.35
  - @trigger.dev/core-backend@3.0.0-beta.35

## 3.0.0-beta.34

### Patch Changes

- 3a1b0c486: v3: Environment variable management API and SDK, along with resolveEnvVars CLI hook
- 3f8b6d8fc: v2: Better handle recovering from platform communication errors by auto-yielding back to the platform in case of temporary API failures
- 1281d40e4: When a v2 run hits the rate limit, reschedule with the reset date
- Updated dependencies [3a1b0c486]
- Updated dependencies [3f8b6d8fc]
- Updated dependencies [1281d40e4]
  - @trigger.dev/core@3.0.0-beta.34
  - @trigger.dev/core-backend@3.0.0-beta.34

## 3.0.0-beta.33

### Patch Changes

- Updated dependencies [6a379e4e9]
  - @trigger.dev/core@3.0.0-beta.33
  - @trigger.dev/core-backend@3.0.0-beta.33

## 3.0.0-beta.32

### Patch Changes

- @trigger.dev/core@3.0.0-beta.32
- @trigger.dev/core-backend@3.0.0-beta.32

## 3.0.0-beta.31

### Patch Changes

- @trigger.dev/core@3.0.0-beta.31
- @trigger.dev/core-backend@3.0.0-beta.31

## 3.0.0-beta.30

### Patch Changes

- Updated dependencies [1477a2e30]
- Updated dependencies [0e919f56f]
  - @trigger.dev/core@3.0.0-beta.30
  - @trigger.dev/core-backend@3.0.0-beta.30

## 3.0.0-beta.29

### Patch Changes

- @trigger.dev/core@3.0.0-beta.29
- @trigger.dev/core-backend@3.0.0-beta.29

## 3.0.0-beta.28

### Patch Changes

- 6d9dfbc75: Add configure function to be able to configure the SDK manually
- Updated dependencies [d490bc5cb]
- Updated dependencies [6d9dfbc75]
  - @trigger.dev/core@3.0.0-beta.28
  - @trigger.dev/core-backend@3.0.0-beta.28

## 3.0.0-beta.27

### Patch Changes

- 203e00208: Add runs.retrieve management API method to get info about a run by run ID
- Updated dependencies [1670c4c41]
- Updated dependencies [203e00208]
  - @trigger.dev/core@3.0.0-beta.27
  - @trigger.dev/core-backend@3.0.0-beta.27

## 3.0.0-beta.26

### Patch Changes

- @trigger.dev/core@3.0.0-beta.26
- @trigger.dev/core-backend@3.0.0-beta.26

## 3.0.0-beta.25

### Patch Changes

- Updated dependencies [e337b2165]
- Updated dependencies [9e5382951]
  - @trigger.dev/core@3.0.0-beta.25
  - @trigger.dev/core-backend@3.0.0-beta.25

## 3.0.0-beta.24

### Patch Changes

- Updated dependencies [83dc87155]
  - @trigger.dev/core@3.0.0-beta.24
  - @trigger.dev/core-backend@3.0.0-beta.24

## 3.0.0-beta.23

### Patch Changes

- @trigger.dev/core@3.0.0-beta.23
- @trigger.dev/core-backend@3.0.0-beta.23

## 3.0.0-beta.22

### Patch Changes

- @trigger.dev/core@3.0.0-beta.22
- @trigger.dev/core-backend@3.0.0-beta.22

## 3.0.0-beta.21

### Patch Changes

- 9491a1649: Implement task.onSuccess/onFailure and config.onSuccess/onFailure
- Updated dependencies [9491a1649]
- Updated dependencies [9491a1649]
  - @trigger.dev/core@3.0.0-beta.21
  - @trigger.dev/core-backend@3.0.0-beta.21

## 3.0.0-beta.20

### Patch Changes

- Updated dependencies [e3db25739]
  - @trigger.dev/core@3.0.0-beta.20
  - @trigger.dev/core-backend@3.0.0-beta.20

## 3.0.0-beta.19

### Patch Changes

- e9a63a486: Lock SDK and CLI deps on exact core version
  - @trigger.dev/core@3.0.0-beta.19
  - @trigger.dev/core-backend@3.0.0-beta.19

## 3.0.0-beta.18

### Patch Changes

- b68012f81: Make msw a normal dependency (for now) to fix Module Not Found error in Next.js.

  It turns out that webpack will "hoist" dynamically imported modules and attempt to resolve them at build time, even though it's an optional peer dep:

  https://x.com/maverickdotdev/status/1782465214308319404

- b68012f81: Move to our global system from AsyncLocalStorage for the current task context storage
- b68012f81: Extracting out all the non-SDK related features from the main @trigger.dev/core/v3 export
- Updated dependencies [b68012f81]
- Updated dependencies [b68012f81]
  - @trigger.dev/core@3.0.0-beta.18
  - @trigger.dev/core-backend@3.0.0-beta.18

## 3.0.0-beta.17

### Patch Changes

- @trigger.dev/core@3.0.0-beta.17
- @trigger.dev/core-backend@3.0.0-beta.17

## 3.0.0-beta.16

### Patch Changes

- Updated dependencies [ed2a26c86]
  - @trigger.dev/core@3.0.0-beta.16
  - @trigger.dev/core-backend@3.0.0-beta.16

## 3.0.0-beta.15

### Patch Changes

- 374edef02: Updates the `trigger`, `batchTrigger` and their `*AndWait` variants to use the first parameter for the payload/items, and the second parameter for options.

  Before:

  ```ts
  await yourTask.trigger({ payload: { foo: "bar" }, options: { idempotencyKey: "key_1234" } });
  await yourTask.triggerAndWait({
    payload: { foo: "bar" },
    options: { idempotencyKey: "key_1234" },
  });

  await yourTask.batchTrigger({
    items: [{ payload: { foo: "bar" } }, { payload: { foo: "baz" } }],
  });
  await yourTask.batchTriggerAndWait({
    items: [{ payload: { foo: "bar" } }, { payload: { foo: "baz" } }],
  });
  ```

  After:

  ```ts
  await yourTask.trigger({ foo: "bar" }, { idempotencyKey: "key_1234" });
  await yourTask.triggerAndWait({ foo: "bar" }, { idempotencyKey: "key_1234" });

  await yourTask.batchTrigger([{ payload: { foo: "bar" } }, { payload: { foo: "baz" } }]);
  await yourTask.batchTriggerAndWait([{ payload: { foo: "bar" } }, { payload: { foo: "baz" } }]);
  ```

  We've also changed the API of the `triggerAndWait` result. Before, if the subtask that was triggered finished with an error, we would automatically "rethrow" the error in the parent task.

  Now instead we're returning a `TaskRunResult` object that allows you to discriminate between successful and failed runs in the subtask:

  Before:

  ```ts
  try {
    const result = await yourTask.triggerAndWait({ foo: "bar" });

    // result is the output of your task
    console.log("result", result);
  } catch (error) {
    // handle subtask errors here
  }
  ```

  After:

  ```ts
  const result = await yourTask.triggerAndWait({ foo: "bar" });

  if (result.ok) {
    console.log(`Run ${result.id} succeeded with output`, result.output);
  } else {
    console.log(`Run ${result.id} failed with error`, result.error);
  }
  ```

- 26093896d: When using idempotency keys, triggerAndWait and batchTriggerAndWait will still work even if the existing runs have already been completed (or even partially completed, in the case of batchTriggerAndWait)

  - TaskRunExecutionResult.id is now the run friendlyId, not the attempt friendlyId
  - A single TaskRun can now have many batchItems, in the case of batchTriggerAndWait while using idempotency keys
  - A run’s idempotencyKey is now added to the ctx as well as the TaskEvent and displayed in the span view
  - When resolving batchTriggerAndWait, the runtimes no longer reject promises, leading to an error in the parent task

- Updated dependencies [374edef02]
- Updated dependencies [26093896d]
- Updated dependencies [62c9a5b71]
  - @trigger.dev/core@3.0.0-beta.15
  - @trigger.dev/core-backend@3.0.0-beta.15

## 3.0.0-beta.14

### Patch Changes

- c9e1a3e9c: Remove unimplemented batchOptions
- Updated dependencies [584c7da5d]
  - @trigger.dev/core@3.0.0-beta.14
  - @trigger.dev/core-backend@3.0.0-beta.14

## 3.0.0-beta.13

### Patch Changes

- 4986bfda2: Export queue from the SDK
- 44e1b8754: Improve the SDK function types and expose a new APIError instead of the APIResult type
- 4986bfda2: Adding task with a triggerSource of schedule
- 4986bfda2: Added a new global - Task Catalog - to better handle task metadata
- Updated dependencies [4986bfda2]
- Updated dependencies [44e1b8754]
- Updated dependencies [4986bfda2]
- Updated dependencies [fde939a30]
- Updated dependencies [03b104a3d]
- Updated dependencies [4986bfda2]
  - @trigger.dev/core@3.0.0-beta.13
  - @trigger.dev/core-backend@3.0.0-beta.13

## 3.0.0-beta.12

### Patch Changes

- @trigger.dev/core@3.0.0-beta.12
- @trigger.dev/core-backend@3.0.0-beta.12

## 3.0.0-beta.11

### Patch Changes

- @trigger.dev/core@3.0.0-beta.11
- @trigger.dev/core-backend@3.0.0-beta.11

## 3.0.0-beta.7

### Patch Changes

- f854cb90e: Added replayRun function to the SDK
- f854cb90e: Added cancelRun to the SDK
- Updated dependencies [f854cb90e]
- Updated dependencies [f854cb90e]
  - @trigger.dev/core@3.0.0-beta.7
  - @trigger.dev/core-backend@3.0.0-beta.7

## 3.0.0-beta.6

### Patch Changes

- Updated dependencies [7ea8532cc]
  - @trigger.dev/core@3.0.0-beta.6
  - @trigger.dev/core-backend@3.0.0-beta.6

## 3.0.0-beta.5

### Patch Changes

- Updated dependencies [eb6012628]
  - @trigger.dev/core@3.0.0-beta.5
  - @trigger.dev/core-backend@3.0.0-beta.5

## 3.0.0-beta.4

### Patch Changes

- @trigger.dev/core@3.0.0-beta.4
- @trigger.dev/core-backend@3.0.0-beta.4

## 3.0.0-beta.3

### Patch Changes

- b271742dc: Configurable log levels in the config file and via env var
- Updated dependencies [c702d6a9c]
- Updated dependencies [b271742dc]
- Updated dependencies [9af2570da]
  - @trigger.dev/core@3.0.0-beta.3
  - @trigger.dev/core-backend@3.0.0-beta.3

## 3.0.0-beta.2

### Patch Changes

- Updated dependencies [e3cf456c6]
  - @trigger.dev/core@3.0.0-beta.2
  - @trigger.dev/core-backend@3.0.0-beta.2

## 3.0.0-beta.1

### Patch Changes

- b66d5525e: add machine config and secure zod connection
- 719c0a0b9: Fixed incorrect span timings around checkpoints by implementing a precise wall clock that resets after restores
- f93eae300: Dynamically import superjson and fix some bundling issues
- Updated dependencies [b66d5525e]
- Updated dependencies [719c0a0b9]
- Updated dependencies [f93eae300]
  - @trigger.dev/core@3.0.0-beta.1
  - @trigger.dev/core-backend@3.0.0-beta.1

## 3.0.0-beta.0

### Major Changes

- 395abe1b9: Updates to support Trigger.dev v3

### Patch Changes

- Updated dependencies [395abe1b9]
  - @trigger.dev/core@3.0.0-beta.0
  - @trigger.dev/core-backend@3.0.0-beta.0

## 2.3.18

### Patch Changes

- @trigger.dev/core@2.3.18
- @trigger.dev/core-backend@2.3.18

## 2.3.17

### Patch Changes

- dd879c8e: Updated run, run statuses and event endpoints to v2 to get full run statuses
  - @trigger.dev/core@2.3.17
  - @trigger.dev/core-backend@2.3.17

## 2.3.16

### Patch Changes

- Updated dependencies [583da458]
  - @trigger.dev/core@2.3.16
  - @trigger.dev/core-backend@2.3.16

## 2.3.15

### Patch Changes

- 6c4047cf: Fix an issue where runs were stuck executing when a child task failed and the parent task retried
  - @trigger.dev/core@2.3.15
  - @trigger.dev/core-backend@2.3.15

## 2.3.14

### Patch Changes

- @trigger.dev/core@2.3.14
- @trigger.dev/core-backend@2.3.14

## 2.3.13

### Patch Changes

- a93b554f: Make it clear that schedules are UTC by appending "UTC" to the end.
- 0f342cd1: Don't show duplicate Job warning if it's an internal job
  - @trigger.dev/core@2.3.13
  - @trigger.dev/core-backend@2.3.13

## 2.3.12

### Patch Changes

- 129f023d: Fix for eventTrigger source not getting passed through
- 38f5a903: Don't auto-yield with no-op tasks (e.g. logs) that are subtasks
- ff4ff869: You can pass an Error() instead of properties to all of the `io.logger` functions
  - @trigger.dev/core@2.3.12
  - @trigger.dev/core-backend@2.3.12

## 2.3.11

### Patch Changes

- @trigger.dev/core@2.3.11
- @trigger.dev/core-backend@2.3.11

## 2.3.10

### Patch Changes

- 8277f4d2: Use correct overload param when invoking a job outside of a run #802
- 73cb8839: Fixed invoke inferred payload types #830
  - @trigger.dev/core@2.3.10
  - @trigger.dev/core-backend@2.3.10

## 2.3.9

### Patch Changes

- f7bf25f0: feat: Add ability to cancel all runs for job from SDK
- Updated dependencies [740b7b23]
  - @trigger.dev/core@2.3.9
  - @trigger.dev/core-backend@2.3.9

## 2.3.8

### Patch Changes

- @trigger.dev/core@2.3.8
- @trigger.dev/core-backend@2.3.8

## 2.3.7

### Patch Changes

- @trigger.dev/core@2.3.7
- @trigger.dev/core-backend@2.3.7

## 2.3.6

### Patch Changes

- @trigger.dev/core@2.3.6
- @trigger.dev/core-backend@2.3.6

## 2.3.5

### Patch Changes

- @trigger.dev/core@2.3.5
- @trigger.dev/core-backend@2.3.5

## 2.3.4

### Patch Changes

- 6a3c563f: Fixed Job.attachToClient
  - @trigger.dev/core@2.3.4
  - @trigger.dev/core-backend@2.3.4

## 2.3.3

### Patch Changes

- @trigger.dev/core@2.3.3
- @trigger.dev/core-backend@2.3.3

## 2.3.2

### Patch Changes

- @trigger.dev/core@2.3.2
- @trigger.dev/core-backend@2.3.2

## 2.3.1

### Patch Changes

- f3efcc0c: Moved Logger to core-backend, no longer importing node:buffer in core/react
- Updated dependencies [f3efcc0c]
  - @trigger.dev/core-backend@2.3.1
  - @trigger.dev/core@2.3.1

## 2.3.0

### Minor Changes

- 17f6f29d: Support for Deno, Bun and Cloudflare workers, as well as conditionally exporting ESM versions of the package instead of just commonjs.

  Cloudflare worker support requires the node compat flag turned on (https://developers.cloudflare.com/workers/runtime-apis/nodejs/)

### Patch Changes

- Updated dependencies [17f6f29d]
  - @trigger.dev/core-backend@2.3.0
  - @trigger.dev/core@2.3.0

## 2.2.11

### Patch Changes

- de652c1d: Fix Shopify task types and KV `get()` return types
  - @trigger.dev/core@2.2.11
  - @trigger.dev/core-backend@2.2.11

## 2.2.10

### Patch Changes

- @trigger.dev/core@2.2.10
- @trigger.dev/core-backend@2.2.10

## 2.2.9

### Patch Changes

- 1dcd87a2: Fix: `Key-Value Store` keys will now be URI encoded
- 6ebd435e: Feature: Run execution concurrency limits
- Updated dependencies [6ebd435e]
  - @trigger.dev/core@2.2.9
  - @trigger.dev/core-backend@2.2.9

## 2.2.8

### Patch Changes

- 067e19fe: - Simplify `Webhook Triggers` and use the new HTTP Endpoints
  - Add a `Key-Value Store` for use in and outside of Jobs
  - Add a `@trigger.dev/shopify` package
- 096151c0: Fix `@trigger.dev/shopify` imports, enhance docs, and suppress HTTP Endpoint warnings
- Updated dependencies [067e19fe]
  - @trigger.dev/core@2.2.8
  - @trigger.dev/core-backend@2.2.8

## 2.2.7

### Patch Changes

- 756024da: Add support for listening to run notifications
- Updated dependencies [756024da]
  - @trigger.dev/core@2.2.7
  - @trigger.dev/core-backend@2.2.7

## 2.2.6

### Patch Changes

- cb1825bf: OpenAI support for 4.16.0
- cb1825bf: Add support for background polling and use that in OpenAI integration to power assistants
- d0217344: Add `io.sendEvents()`
- cb1825bf: Adding support for waitForEvent
- Updated dependencies [cb1825bf]
- Updated dependencies [cb1825bf]
- Updated dependencies [d0217344]
  - @trigger.dev/core@2.2.6
  - @trigger.dev/core-backend@2.2.6

## 2.2.5

### Patch Changes

- 7e57f1f3: [TRI-1449] Display warning message when duplicate job IDs are detected
- cf8f9946: Add `io.random()` which wraps `Math.random()` in a Task with helpful options.
- a74716a1: Added waitForRequest built-in tasks
- 620b8383: Added invokeTrigger(), which allows jobs to be manually invoked
- 4a0f030e: Adding no-cache to our client fetch to fix Next.js POST caching
- f4275e50: verifyRequestSignature – added an error if the passed in secret is undefined or empty
- Updated dependencies [620b8383]
- Updated dependencies [578d2e54]
  - @trigger.dev/core@2.2.5
  - @trigger.dev/core-backend@2.2.5

## 2.2.4

### Patch Changes

- c1710ae7: Creates a new package @trigger.dev/core-backend that includes code shared between @trigger.dev/sdk and the Trigger.dev server
- 9c4be40a: use idempotency-key as event-id for dynamic-trigger registrations
- Updated dependencies [c1710ae7]
  - @trigger.dev/core-backend@2.2.4
  - @trigger.dev/core@2.2.4

## 2.2.3

### Patch Changes

- 6e1b8a11: implement functionality to cancel job runs triggered by a given eventId.
- c4533c36: set error messages in runTask and executeJob
- Updated dependencies [6e1b8a11]
  - @trigger.dev/core@2.2.3

## 2.2.2

### Patch Changes

- @trigger.dev/core@2.2.2

## 2.2.1

### Patch Changes

- 044d38e3: Auto-yield run execution to help prevent duplicate task executions
- Updated dependencies [044d38e3]
- Updated dependencies [abc9737a]
  - @trigger.dev/core@2.2.1

## 2.2.0

### Minor Changes

- 975c5f1d: Drop support for Node v16, require Node >= 18. This allows us to use native fetch in our SDK which paves the way for multi-platform support.

### Patch Changes

- Updated dependencies [975c5f1d]
- Updated dependencies [50e3d9e4]
- Updated dependencies [59a94c71]
  - @trigger.dev/core@2.2.0

## 2.1.9

### Patch Changes

- 9a187f9e: upgrade zod to 3.22.3
- 2e9452ab: allow cancelling jobs from trigger-client
- Updated dependencies [9a187f9e]
  - @trigger.dev/core@2.1.9

## 2.1.8

### Patch Changes

- 6a992a19: First release of `@trigger.dev/replicate` integration with remote callback support.
- ab9e4a98: Send client version back to the server via headers
- ab9e4a98: Better performance when resuming a run, especially one with a large amount of tasks
- Updated dependencies [6a992a19]
- Updated dependencies [ab9e4a98]
- Updated dependencies [ab9e4a98]
  - @trigger.dev/core@2.1.8

## 2.1.7

### Patch Changes

- @trigger.dev/core@2.1.7

## 2.1.6

### Patch Changes

- @trigger.dev/core@2.1.6

## 2.1.5

### Patch Changes

- @trigger.dev/core@2.1.5

## 2.1.4

### Patch Changes

- ad14983e: You can create statuses in your Jobs that can then be read using React hooks
- 15f17d27: First release of `@trigger.dev/linear` integration. `io.runTask()` error handlers can now prevent further retries.
- 50137a6f: Decouple zod
- c0dfa804: Add support for Bring Your Own Auth
- Updated dependencies [ad14983e]
- Updated dependencies [50137a6f]
- Updated dependencies [c0dfa804]
  - @trigger.dev/core@2.1.4

## 2.1.3

### Patch Changes

- Fix for bad publish
- Updated dependencies:
  - `@trigger.dev/core@2.1.3`

## 2.1.2

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@2.1.2`

## 2.1.1

### Patch Changes

- Errors now bubbled up. OpenAI background retrying improved ([#468](https://github.com/triggerdotdev/trigger.dev/pull/468))
- Updated dependencies:
  - `@trigger.dev/core@2.1.1`

## 2.1.0

### Minor Changes

- Integrations are now simpler and support authentication during webhook registration ([`878da3c0`](https://github.com/triggerdotdev/trigger.dev/commit/878da3c01f0a4dfaf33a1f8943a7ad4eed8b8877))

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@2.1.0`

## 2.1.0-beta.1

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@2.1.0-beta.1`

## 2.1.0-beta.0

### Minor Changes

- Integrations are now simpler and support authentication during webhook registration ([`878da3c0`](https://github.com/triggerdotdev/trigger.dev/commit/878da3c01f0a4dfaf33a1f8943a7ad4eed8b8877))

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@2.1.0-beta.0`

## 2.0.14

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@2.0.14`

## 2.0.13

### Patch Changes

- Only use cached tasks if they are completed, otherwise retrying tasks will be considered successful ([`916a3536`](https://github.com/triggerdotdev/trigger.dev/commit/916a353660e251946d76bdf565c26b7801d3beb8))
- Updated dependencies:
  - `@trigger.dev/core@2.0.13`

## 2.0.12

### Patch Changes

- @trigger.dev/core@2.0.12

## 2.0.11

### Patch Changes

- ac98219b: Adding the ability to cancel events that were sent with a delayed delivery
- 302bd02f: Issue #377: only expose the external eventId in the API
- b5db9f5e: Adding MIT license
- 3ce53970: Support disabling jobs using the `enabled` flag
- Updated dependencies [302bd02f]
- Updated dependencies [b5db9f5e]
  - @trigger.dev/core@2.0.11

## 2.0.10

### Patch Changes

- b1b9321a: Fixed IO not setting the cached task key correctly, resulting in unnecessary API calls to trigger.dev
- b1b9321a: Deprecated queue options in the job and removed startPosition
- Updated dependencies [b1b9321a]
  - @trigger.dev/core@2.0.10

## 2.0.9

### Patch Changes

- Updated dependencies [33184a81]
  - @trigger.dev/core@2.0.9

## 2.0.8

### Patch Changes

- @trigger.dev/core@2.0.8

## 2.0.7

### Patch Changes

- Updated dependencies [fa3a22eb]
  - @trigger.dev/core@2.0.7

## 2.0.6

### Patch Changes

- Updated dependencies [59075f5f]
  - @trigger.dev/core@2.0.6

## 2.0.5

### Patch Changes

- @trigger.dev/core@2.0.5

## 2.0.4

### Patch Changes

- 96384991: Adding the validate endpoint action to be able to add an endpoint first in the dashboard
- Updated dependencies [96384991]
  - @trigger.dev/core@2.0.4

## 2.0.3

### Patch Changes

- @trigger.dev/core@2.0.3

## 2.0.2

### Patch Changes

- 0a790de2: core version changed to 1.0.0. Dependencies for core set to ^1.0.0
- ee99191f: Sync all package versions
- Updated dependencies [0a790de2]
- Updated dependencies [ee99191f]
  - @trigger.dev/core@2.0.2

## 2.0.1

### Patch Changes

- aa9fe7d4: core made public. The react and sdk packages now have it as a dependency.
- Updated dependencies [aa9fe7d4]
  - @trigger.dev/core@0.0.5

## 2.0.0

### Major Changes

- 99316df8: Preparing packages for V2

### Patch Changes

- acaae993: run context jsdocs
- 92233f2e: @trigger.dev/core is now a separate package
- cca7da9d: Better docs for io.try
- 9138976d: Multiple eventname support in eventDispatcher
- 486d6818: IO Logging now respects the job and client logLevel, and only outputs locally when ioLogLocalEnabled is true
- 24542d4e: Adding support for trigger source in the run context, and make sure dynamic trigger runs are preprocessed so they have a chance of populating run properties
- c34a02c0: Improved OpenAI task errors
- 5ee0b188: Don't return the apiKey when they don't match
- 28914b87: Creating the init CLI package
- 722fe7b7: registerCron and unregisterCron jsdocs
- 1961b994: added defineJob in TriggerClient
- 1dc42dae: Added support for Runs being canceled
- d6310a79: Set duplex "half" when creating fetch based Request objects when they have a body
- 817b4ed1: Endpoint registration and indexing now is only initiated outside of clients
- f01af9c0: Upgrade to zod 3.21.4
- 6d4922f4: api.trigger.dev is now the default cloud url
- 34ccf345: Add support for task errors and task retrying
- b314178d: Added getEvent(), getRun() and getRuns() methods to the client
- 69af845a: Make isRetry context property backwards compatible and add it to the TriggerContext type
- c83443a4: io.runTask jsdocs
- 8e147dbe: io.sendEvent jsdocs
- 2cbf50b1: deliverAt and timestamp event properties are now dates
- 92233f2e: Packages move to @latest
- b4167a38: Fixed the eventTrigger name
- 931be399: cronTrigger jsdocs
- facae926: Fix for a console warning about "encoding" with node-fetch
- 6d04f6c6: Add default retry settings for integrations tasks
- a11ddf65: Added JSDocs related to logging
- ba446524: intervalTrigger() jsdocs
- 6c869466: Fixed responses from the PING action to match expected schema
- f2f4d4b8: Adding more granular error messages around unauthorized requests
- e4b0b1e3: Added support for backgroundFetch
- 094f6f5a: jsdocs for DynamicTrigger and DynamicSchedule
- 2c0ea0c1: Set Node version to 16.8 and above
- e26923eb: backgroundFetch jsdocs
- 0066971b: added isRetry in context run
- c83443a4: registerTrigger jsdocs
- 99c6cd03: io.registerInterval and io.unregisterInterval jsdocs
- 3ee396d7: Creating the typeform integration package
- 7e2d48ac: Removed the url option for TriggerClient
- 86dbd5d1: Added JSdocs for io.wait and io.logger
- f160b34b: isTriggerError jsdocs
- aaa70a9a: eventTrigger() jsdocs
- 61ed1fb2: Adding support for output properties on tasks
- 01cf5f3b: io.try jsdocs
- 9351c051: Initial Stripe integration
- 953e7fc9: Added human readable cron expression property to cron triggers
- 0012bb21: All logs are now structured logs
- 807b9d4c: Added jsdocs for TriggerClient() and sendEvent()
- 64477f6b: Adding some type helpers for getting the payload and IO types from jobs and triggers
- 7f6bf992: Show the params to updateSource in the dashboard
- 767e09ee: Added io.integration.runTask and initial @trigger.dev/supabase integration
- 917a70fb: Added JSdocs for Job

## 2.0.0-next.22

### Patch Changes

- 64477f6b: Adding some type helpers for getting the payload and IO types from jobs and triggers

## 2.0.0-next.21

### Patch Changes

- 9351c051: Initial Stripe integration

## 2.0.0-next.20

### Patch Changes

- b314178d: Added getEvent(), getRun() and getRuns() methods to the client

## 2.0.0-next.19

### Patch Changes

- 767e09ee: Added io.integration.runTask and initial @trigger.dev/supabase integration

## 2.0.0-next.18

### Patch Changes

- 1961b994: added defineJob in TriggerClient
- 69af845a: Make isRetry context property backwards compatible and add it to the TriggerContext type
- 0066971b: added isRetry in context run

## 2.0.0-next.17

### Patch Changes

- 7f6bf992: Show the params to updateSource in the dashboard

## 2.0.0-next.16

### Patch Changes

- 1dc42dae: Added support for Runs being canceled
- d6310a79: Set duplex "half" when creating fetch based Request objects when they have a body
- 0012bb21: All logs are now structured logs

## 2.0.0-next.15

### Patch Changes

- 2c0ea0c1: Set Node version to 16.8 and above

## 2.0.0-next.14

### Patch Changes

- c34a02c0: Improved OpenAI task errors
- 61ed1fb2: Adding support for output properties on tasks

## 2.0.0-next.13

### Patch Changes

- 5ee0b188: Don't return the apiKey when they don't match

## 2.0.0-next.12

### Patch Changes

- f01af9c0: Upgrade to zod 3.21.4

## 2.0.0-next.11

### Patch Changes

- 931be399: cronTrigger jsdocs
- ba446524: intervalTrigger() jsdocs
- 094f6f5a: jsdocs for DynamicTrigger and DynamicSchedule
- 3ee396d7: Creating the typeform integration package

## 2.0.0-next.10

### Patch Changes

- 6d4922f4: api.trigger.dev is now the default cloud url

## 2.0.0-next.9

### Patch Changes

- acaae993: run context jsdocs
- aaa70a9a: eventTrigger() jsdocs

## 2.0.0-next.8

### Patch Changes

- cca7da9d: Better docs for io.try
- 722fe7b7: registerCron and unregisterCron jsdocs
- c83443a4: io.runTask jsdocs
- c83443a4: registerTrigger jsdocs
- 99c6cd03: io.registerInterval and io.unregisterInterval jsdocs
- f160b34b: isTriggerError jsdocs
- 01cf5f3b: io.try jsdocs

## 2.0.0-next.7

### Patch Changes

- 2cbf50b1: deliverAt and timestamp event properties are now dates
- e26923eb: backgroundFetch jsdocs

## 2.0.0-next.6

### Patch Changes

- 486d6818: IO Logging now respects the job and client logLevel, and only outputs locally when ioLogLocalEnabled is true
- 8e147dbe: io.sendEvent jsdocs
- a11ddf65: Added JSDocs related to logging
- 6c869466: Fixed responses from the PING action to match expected schema
- 86dbd5d1: Added JSdocs for io.wait and io.logger
- 953e7fc9: Added human readable cron expression property to cron triggers
- 807b9d4c: Added jsdocs for TriggerClient() and sendEvent()
- 917a70fb: Added JSdocs for Job

## 2.0.0-next.5

### Patch Changes

- 7e2d48ac: Removed the url option for TriggerClient

## 2.0.0-next.4

### Patch Changes

- f2f4d4b8: Adding more granular error messages around unauthorized requests

## 2.0.0-next.3

### Patch Changes

- 24542d4e: Adding support for trigger source in the run context, and make sure dynamic trigger runs are preprocessed so they have a chance of populating run properties

## 2.0.0-next.2

### Patch Changes

- 28914b87: Creating the init CLI package
- 817b4ed1: Endpoint registration and indexing now is only initiated outside of clients
- e4b0b1e3: Added support for backgroundFetch

## 2.0.0-next.1

### Patch Changes

- Add support for task errors and task retrying
- b4167a38: Fixed the eventTrigger name

## 2.0.0-next.0

### Major Changes

- 53c9bd56: Preparing packages for V2

## 0.2.22

### Patch Changes

- ab512157: Fixed an error message
- 1673d452: Added kv storage to persist data in between runs and between workflows
- 0b67b51a: Fix ESM error by dynamically importing ESM packages (chalk, terminal-link, etc.)
- f39bc44e: SDK now passes through the project ID from the env var

## 0.2.22-next.0

### Patch Changes

- ab512157: Fixed an error message
- 1673d452: Added kv storage to persist data in between runs and between workflows
- 0b67b51a: Fix ESM error by dynamically importing ESM packages (chalk, terminal-link, etc.)
- f39bc44e: SDK now passes through the project ID from the env var

## 0.2.21

### Patch Changes

- c5084209: Fix for metadata capture when using npm/yarn

## 0.2.20

### Patch Changes

- 5ec71980: Send additional metadata about a workflow when initializing the host

## 0.2.19

### Patch Changes

- b5724195: Fixed issue where default webhook schema wasn't being used which caused an error

## 0.2.18

### Patch Changes

- c72120ea: Removed accidental log statement

## 0.2.17

### Patch Changes

- 3a2cf0dd: Fixed the missing error message when logging invalid API key and improved the error message

## 0.2.16

### Patch Changes

- ee20f921: Make the schema an optional param for customEvent and webhookEvent
- 4f47d031: Give a better error message when the API key is invalid
- 87a3bbee: Added a more helpful error message when missing an API key
- 51f9bc9d: Added handly links to the dashboard in log feedback
- 0932ae7d: Log out when a run first starts as well

## 0.2.16-next.3

### Patch Changes

- Give a better error message when the API key is invalid

## 0.2.16-next.2

### Patch Changes

- 87a3bbee: Added a more helpful error message when missing an API key

## 0.2.16-next.1

### Patch Changes

- 0932ae7d: Log out when a run first starts as well

## 0.2.16-next.0

### Patch Changes

- ee20f921: Make the schema an optional param for customEvent and webhookEvent
- 51f9bc9d: Added handly links to the dashboard in log feedback

## 0.2.15

### Patch Changes

- 6b53aeb: New integrations service compatibility
- 9eeacee: Fix: pass in the id from sendEvent through to the API call

## 0.2.15-next.0

### Patch Changes

- 6b53aeb: New integrations service compatibility

## 0.2.14

### Patch Changes

- 179afbb: Automatically pickup on the TRIGGER_WSS_URL for the wss endpoint

## 0.2.13

### Patch Changes

- 710bcc2: Handle errors when calling listen and provide some log feedback

## 0.2.12

### Patch Changes

- 2a51c5a: Generate and send JSON Schema for custom and webhook events
- 0d2d9a0: Added runOnce and runOnceLocalOnly to support running idempotent actions
- 0e4ec8d: Added views and view submission support to Slack integration

## 0.2.12-next.0

### Patch Changes

- 2a51c5a: Generate and send JSON Schema for custom and webhook events
- 0d2d9a0: Added runOnce and runOnceLocalOnly to support running idempotent actions
- 0e4ec8d: Added views and view submission support to Slack integration

## 0.2.11

### Patch Changes

- 52d21ac: Added support for delaying delivery when sending custom events
- b290410: Slack blocks support

## 0.2.10

### Patch Changes

- e37a200: Added lastRunAt to the scheduleEvent payload
- e63d354: Added isTest to TriggerContext

## 0.2.9

### Patch Changes

- 039321f: Improved types for the Resend integration

## 0.2.8

### Patch Changes

- ddf4255: Added support for webhookEvent trigger
- 2fd9e4f: Added retry options to fetch

## 0.2.7

### Patch Changes

- 39b167e: Better handle event parsing errors from Zod

## 0.2.6

### Patch Changes

- f316c6e: Add ability to use fetch without having to use context param
- c69c370: Added context.fetch to make generic fetch requests using Trigger.dev

## 0.2.5

### Patch Changes

- 6673798: Bundling common-schemas into @trigger.dev/sdk

## 0.2.4

### Patch Changes

- 0b17912: Updated dependency to @trigger.dev/core@0.1.0

## 0.2.3

### Patch Changes

- ce0d4b9: When posting a message to Slack, you must explicitly specify either channelId or channelName

## 0.2.2

### Patch Changes

- 7f26548: Added some logging messages (and disabled any messages by default)
- 5de2a1a: Fixed issue with workflow runs not completing when the run function returned undefined or null
- d3c593c: Added triggerTTL option that prevents old events from running a workflow

## 0.2.1

### Patch Changes

- 7d23a7b: Added the sendEvent function

## 0.2.0

### Minor Changes

- 8b7b8a8: Added scheduled events

## 0.1.2

### Patch Changes

- ae042a7: Providers is now a public package: @trigger.dev/providers

## 0.1.1

### Patch Changes

- bcda9c8: Initial publish of the @trigger.dev packages
