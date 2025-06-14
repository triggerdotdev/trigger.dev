# internal-platform

## 4.0.0-v4-beta.22

### Patch Changes

- Fixes an issue with realtime when re-subscribing to a run, that would temporarily display stale data and the changes. Now when re-subscribing to a run only the latest changes will be vended ([#2162](https://github.com/triggerdotdev/trigger.dev/pull/2162))

## 4.0.0-v4-beta.21

### Patch Changes

- Runtime agnostic SDK config via env vars ([#2132](https://github.com/triggerdotdev/trigger.dev/pull/2132))
- - Resolve issue where CLI could get stuck during deploy finalization ([#2138](https://github.com/triggerdotdev/trigger.dev/pull/2138))
  - Unify local and remote build logic, with multi-platform build support
  - Improve switch command; now accepts profile name as an argument
  - Registry configuration is now fully managed by the webapp
  - The deploy `--self-hosted` flag is no longer required
  - Enhance deployment error reporting and image digest retrieval

## 4.0.0-v4-beta.20

## 4.0.0-v4-beta.19

### Patch Changes

- Add supervisor http client option to disable debug logs ([#2116](https://github.com/triggerdotdev/trigger.dev/pull/2116))
- Add import timings and bundle size analysis, the dev command will now warn about slow imports ([#2114](https://github.com/triggerdotdev/trigger.dev/pull/2114))
- Improve metadata flushing efficiency by collapsing operations ([#2106](https://github.com/triggerdotdev/trigger.dev/pull/2106))

## 4.0.0-v4-beta.18

## 4.0.0-v4-beta.17

### Patch Changes

- Expose esbuild `keepNames` option (experimental) ([#2091](https://github.com/triggerdotdev/trigger.dev/pull/2091))
- Add `experimental_autoDetectExternal` trigger config option ([#2083](https://github.com/triggerdotdev/trigger.dev/pull/2083))
- Improve structured logs ([#2062](https://github.com/triggerdotdev/trigger.dev/pull/2062))
- Add verbose structured log level ([#2062](https://github.com/triggerdotdev/trigger.dev/pull/2062))
- Expose esbuild `minify` option (experimental) ([#2091](https://github.com/triggerdotdev/trigger.dev/pull/2091))

## 4.0.0-v4-beta.16

## 4.0.0-v4-beta.15

## 4.0.0-v4-beta.14

## 4.0.0-v4-beta.13

### Patch Changes

- - Correctly resolve waitpoints that come in early ([#2006](https://github.com/triggerdotdev/trigger.dev/pull/2006))
  - Ensure correct state before requesting suspension
  - Fix race conditions in snapshot processing

## 4.0.0-v4-beta.12

## 4.0.0-v4-beta.11

## 4.0.0-v4-beta.10

### Patch Changes

- - Fix polling interval reset bug that could create duplicate intervals ([#1987](https://github.com/triggerdotdev/trigger.dev/pull/1987))
  - Protect against unexpected attempt number changes
  - Prevent run execution zombies after warm starts

## 4.0.0-v4-beta.9

## 4.0.0-v4-beta.8

### Patch Changes

- Prevent large outputs from overwriting each other ([#1971](https://github.com/triggerdotdev/trigger.dev/pull/1971))

## 4.0.0-v4-beta.7

### Patch Changes

- Fix QUEUED status snapshot handler ([#1963](https://github.com/triggerdotdev/trigger.dev/pull/1963))

## 4.0.0-v4-beta.6

### Patch Changes

- The dev command will now use the platform-provided engine URL ([#1949](https://github.com/triggerdotdev/trigger.dev/pull/1949))
- Configurable queue consumer count in supervisor session ([#1949](https://github.com/triggerdotdev/trigger.dev/pull/1949))

## 4.0.0-v4-beta.5

## 4.0.0-v4-beta.4

## 4.0.0-v4-beta.3

### Patch Changes

- Improve usage flushing ([#1931](https://github.com/triggerdotdev/trigger.dev/pull/1931))

## 4.0.0-v4-beta.2

### Patch Changes

- Managed run controller performance and reliability improvements ([#1927](https://github.com/triggerdotdev/trigger.dev/pull/1927))

## 4.0.0-v4-beta.1

## 4.0.0-v4-beta.0

### Major Changes

- Trigger.dev v4 release. Please see our upgrade to v4 docs to view the full changelog: https://trigger.dev/docs/upgrade-to-v4 ([#1869](https://github.com/triggerdotdev/trigger.dev/pull/1869))

### Patch Changes

- Run Engine 2.0 (alpha) ([#1575](https://github.com/triggerdotdev/trigger.dev/pull/1575))
- Suppress external instrumentation for fetch calls from ApiClient ([#1788](https://github.com/triggerdotdev/trigger.dev/pull/1788))
- fix: Realtime streams: prevent enqueuing into closed ReadableStream ([#1781](https://github.com/triggerdotdev/trigger.dev/pull/1781))
- v4: New lifecycle hooks ([#1817](https://github.com/triggerdotdev/trigger.dev/pull/1817))

## 3.3.17

### Patch Changes

- Add manual checkpoint schema ([#1709](https://github.com/triggerdotdev/trigger.dev/pull/1709))
- - Add new run completion submission message with ack ([#1711](https://github.com/triggerdotdev/trigger.dev/pull/1711))
  - Add timeout support to sendWithAck

## 3.3.16

## 3.3.15

## 3.3.14

## 3.3.13

### Patch Changes

- Allow setting concurrencyLimit to null to signal removing the concurrency limit on the queue ([#1653](https://github.com/triggerdotdev/trigger.dev/pull/1653))
- Fixed issue with asResponse and withResponse not working on runs.retrieve ([#1648](https://github.com/triggerdotdev/trigger.dev/pull/1648))
- Fixed deploy timeout issues and improve the output of logs when deploying ([#1661](https://github.com/triggerdotdev/trigger.dev/pull/1661))

## 3.3.12

### Patch Changes

- Add --experimental-global-webcrypto node option fix "crypto is not defined error" on Node.js 18 in dev ([#1623](https://github.com/triggerdotdev/trigger.dev/pull/1623))
- Fix broken cloud deploys by using depot ephemeral registry ([#1637](https://github.com/triggerdotdev/trigger.dev/pull/1637))

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

- Add otel exporter support ([#1602](https://github.com/triggerdotdev/trigger.dev/pull/1602))
- Detect parallel waits and show a useful error message ([`6d17443e1`](https://github.com/triggerdotdev/trigger.dev/commit/6d17443e16362bc81261d30d04d4fa1c5a4de977))
- Require maxDuration config and have a better error for bad CI tokens ([#1620](https://github.com/triggerdotdev/trigger.dev/pull/1620))

## 3.3.10

### Patch Changes

- Handle errors thrown by requests in Realtime react hooks ([#1599](https://github.com/triggerdotdev/trigger.dev/pull/1599))

## 3.3.9

### Patch Changes

- Adding ability to update parent run metadata from child runs/tasks ([#1563](https://github.com/triggerdotdev/trigger.dev/pull/1563))

## 3.3.8

### Patch Changes

- Fix realtime safari bug because of missing ReadableStream async iterable support ([#1585](https://github.com/triggerdotdev/trigger.dev/pull/1585))
- Fix issue with dates in realtime not reflecting the current timezone ([#1585](https://github.com/triggerdotdev/trigger.dev/pull/1585))

## 3.3.7

## 3.3.6

### Patch Changes

- Add option to trigger batched items sequentially, and default to parallel triggering which is faster ([#1536](https://github.com/triggerdotdev/trigger.dev/pull/1536))

## 3.3.5

### Patch Changes

- Fix an issue that caused errors when using realtime with a run that is cancelled ([#1533](https://github.com/triggerdotdev/trigger.dev/pull/1533))

## 3.3.4

## 3.3.3

### Patch Changes

- Multiple streams can now be consumed simultaneously ([#1522](https://github.com/triggerdotdev/trigger.dev/pull/1522))

## 3.3.2

## 3.3.1

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

## 3.2.2

## 3.2.1

### Patch Changes

- Upgrade zod to latest (3.23.8) ([#1484](https://github.com/triggerdotdev/trigger.dev/pull/1484))
- Realtime streams ([#1470](https://github.com/triggerdotdev/trigger.dev/pull/1470))

## 3.2.0

## 3.1.2

## 3.1.1

### Patch Changes

- Pass init output to both local and global `handleError` functions ([#1441](https://github.com/triggerdotdev/trigger.dev/pull/1441))
- Add outdated SDK error ([#1453](https://github.com/triggerdotdev/trigger.dev/pull/1453))
- Add individual run ids to auto-generated public access token when calling batchTrigger ([#1449](https://github.com/triggerdotdev/trigger.dev/pull/1449))

## 3.1.0

### Minor Changes

- Access run status updates in realtime, from your server or from your frontend ([#1402](https://github.com/triggerdotdev/trigger.dev/pull/1402))

### Patch Changes

- Fix: Handle circular references in flattenAttributes function ([#1433](https://github.com/triggerdotdev/trigger.dev/pull/1433))
- - Include retries.default in task retry config when indexing ([#1424](https://github.com/triggerdotdev/trigger.dev/pull/1424))
  - New helpers for internal error retry mechanics
  - Detection for segfaults and ffmpeg OOM errors
  - Retries for packet import and export

## 3.0.13

### Patch Changes

- SIGTERM detection and prettier errors ([#1418](https://github.com/triggerdotdev/trigger.dev/pull/1418))

## 3.0.12

### Patch Changes

- Prettier and more specific errors with links to docs ([#1387](https://github.com/triggerdotdev/trigger.dev/pull/1387))
- Improvements to structured logger and conditional payload logging ([#1389](https://github.com/triggerdotdev/trigger.dev/pull/1389))
- Correctly display errors on attempts and during indexing ([#1397](https://github.com/triggerdotdev/trigger.dev/pull/1397))

## 3.0.11

## 3.0.10

### Patch Changes

- Adding maxDuration to tasks to allow timing out runs after they exceed a certain number of seconds ([#1377](https://github.com/triggerdotdev/trigger.dev/pull/1377))

## 3.0.9

### Patch Changes

- fix: run metadata not working when using npx/pnpm dlx ([`4c1ee3d6e`](https://github.com/triggerdotdev/trigger.dev/commit/4c1ee3d6ea5f2e1dfc9f475c99ecd236bf780a19))

## 3.0.8

### Patch Changes

- Add otel propagation headers "below" the API fetch span, to attribute the child runs with the proper parent span ID ([#1352](https://github.com/triggerdotdev/trigger.dev/pull/1352))
- Add Run metadata to allow for storing up to 4KB of data on a run and update it during the run ([#1357](https://github.com/triggerdotdev/trigger.dev/pull/1357))

## 3.0.7

## 3.0.6

### Patch Changes

- 4e0bc485a: Add support for Buffer in payloads and outputs

## 3.0.5

## 3.0.4

### Patch Changes

- 4adc773c7: Auto-resolve payload/output presigned urls when retrieving a run with runs.retrieve

## 3.0.3

### Patch Changes

- 3d53d4c08: Fix an issue where a missing tsconfig.json file would throw an error on dev/deploy

## 3.0.2

## 3.0.1

### Patch Changes

- 3aa581179: Fixing false-positive package version mismatches

## 3.0.0

### Major Changes

- cf13fbdf3: Release 3.0.0
- 395abe1b9: Updates to support Trigger.dev v3

### Patch Changes

- ed2a26c86: - Fix additionalFiles that aren't decendants
  - Stop swallowing uncaught exceptions in prod
  - Improve warnings and errors, fail early on critical warnings
  - New arg to --save-logs even for successful builds
- c702d6a9c: better handle task metadata parse errors, and display nicely formatted errors
- 9882d66f8: Pre-pull deployment images for faster startups
- b66d5525e: add machine config and secure zod connection
- e3db25739: Fix error stack traces
- 9491a1649: Implement task.onSuccess/onFailure and config.onSuccess/onFailure
- 1670c4c41: Remove "log" Log Level, unify log and info messages under the "info" log level
- b271742dc: Configurable log levels in the config file and via env var
- dbda820a7: - Prevent uncaught exceptions when handling WebSocket messages
  - Improve CLI dev command WebSocket debug and error logging
- 4986bfda2: Add option to print console logs in the dev CLI locally (issue #1014)
- eb6012628: Fixed batch otel flushing
- f9ec66c56: New Build System
- f7d32b83b: Removed the folder/filepath from Attempt spans
- 09413a62a: Added version to ctx.run
- 3a1b0c486: v3: Environment variable management API and SDK, along with resolveEnvVars CLI hook
- 203e00208: Add runs.retrieve management API method to get info about a run by run ID
- b4f9b70ae: Support triggering tasks with non-URL friendly characters in the ID
- 1b90ffbb8: v3: Usage tracking
- 5cf90da72: Fix issues that could result in unreezable state run crashes. Details:
  - Never checkpoint between attempts
  - Some messages and socket data now include attempt numbers
  - Remove attempt completion replays
  - Additional prod entry point logging
  - Fail runs that receive deprecated (pre-lazy attempt) execute messages
- 9af2570da: Retry 429, 500, and connection error API requests to the trigger.dev server
- 7ea8532cc: Display errors for runs and deployments
- 1477a2e30: Increased the timeout when canceling a checkpoint to 31s (to match the timeout on the server)
- 4f95c9de4: v3: recover from server rate limiting errors in a more reliable way
- 83dc87155: Fix issues with consecutive waits
- d490bc5cb: Add the "log" level back in as an alias to "info"
- e3cf456c6: Handle string and non-stringifiable outputs like functions
- 14c2bdf89: Tasks should now be much more robust and resilient to reconnects during crucial operations and other failure scenarios.

  Task runs now have to signal checkpointable state prior to ALL checkpoints. This ensures flushing always happens.

  All important socket.io RPCs will now be retried with backoff. Actions relying on checkpoints will be replayed if we haven't been checkpointed and restored as expected, e.g. after reconnect.

  Other changes:

  - Fix retry check in shared queue
  - Fix env var sync spinner
  - Heartbeat between retries
  - Fix retry prep
  - Fix prod worker no tasks detection
  - Fail runs above `MAX_TASK_RUN_ATTEMPTS`
  - Additional debug logs in all places
  - Prevent crashes due to failed socket schema parsing
  - Remove core-apps barrel
  - Upgrade socket.io-client to fix an ACK memleak
  - Additional index failure logs
  - Prevent message loss during reconnect
  - Prevent burst of heartbeats on reconnect
  - Prevent crash on failed cleanup
  - Handle at-least-once lazy execute message delivery
  - Handle uncaught entry point exceptions

- 9491a1649: Adds support for `emitDecoratorMetadata: true` and `experimentalDecorators: true` in your tsconfig using the [`@anatine/esbuild-decorators`](https://github.com/anatine/esbuildnx/tree/main/packages/esbuild-decorators) package. This allows you to use libraries like TypeORM:

  ```ts orm/index.ts
  import "reflect-metadata";
  import { DataSource } from "typeorm";
  import { Entity, Column, PrimaryColumn } from "typeorm";

  @Entity()
  export class Photo {
    @PrimaryColumn()
    id!: number;

    @Column()
    name!: string;

    @Column()
    description!: string;

    @Column()
    filename!: string;

    @Column()
    views!: number;

    @Column()
    isPublished!: boolean;
  }

  export const AppDataSource = new DataSource({
    type: "postgres",
    host: "localhost",
    port: 5432,
    username: "postgres",
    password: "postgres",
    database: "v3-catalog",
    entities: [Photo],
    synchronize: true,
    logging: false,
  });
  ```

  And then in your trigger.config.ts file you can initialize the datasource using the new `init` option:

  ```ts trigger.config.ts
  import type { TriggerConfig } from "@trigger.dev/sdk/v3";
  import { AppDataSource } from "@/trigger/orm";

  export const config: TriggerConfig = {
    // ... other options here
    init: async (payload, { ctx }) => {
      await AppDataSource.initialize();
    },
  };
  ```

  Now you are ready to use this in your tasks:

  ```ts
  import { task } from "@trigger.dev/sdk/v3";
  import { AppDataSource, Photo } from "./orm";

  export const taskThatUsesDecorators = task({
    id: "taskThatUsesDecorators",
    run: async (payload: { message: string }) => {
      console.log("Creating a photo...");

      const photo = new Photo();
      photo.id = 2;
      photo.name = "Me and Bears";
      photo.description = "I am near polar bears";
      photo.filename = "photo-with-bears.jpg";
      photo.views = 1;
      photo.isPublished = true;

      await AppDataSource.manager.save(photo);
    },
  });
  ```

- 0ed93a748: v3: Remove aggressive otel flush timeouts in dev/prod
- 8578c9b28: Support self-hosters pushing to a custom registry when running deploy
- 0e77e7ef7: v3: Trigger delayed runs and reschedule them
- e417aca87: Added config option extraCACerts to ProjectConfig type. This copies the ca file along with additionalFiles and sets NODE_EXTRA_CA_CERTS environment variable in built image as well as running the task.
- 568da0178: - Improve non-zero exit code error messages
  - Detect OOM conditions within worker child processes
  - Internal errors can have optional stack traces
  - Docker provider can be set to enforce machine presets
- c738ef39c: OTEL attributes can include Dates that will be formatted as ISO strings
- ece6ca678: Fix issue when using SDK in non-node environments by scoping the stream import with node:
- f854cb90e: Added replayRun function to the SDK
- 0e919f56f: Better handle uncaught exceptions
- 44e1b8754: Improve the SDK function types and expose a new APIError instead of the APIResult type
- 55264657d: You can now add tags to runs and list runs using them
- 6d9dfbc75: Add configure function to be able to configure the SDK manually
- e337b2165: Add a postInstall option to allow running scripts after dependencies have been installed in deployed images
- 719c0a0b9: Fixed incorrect span timings around checkpoints by implementing a precise wall clock that resets after restores
- 4986bfda2: Adding task with a triggerSource of schedule
- e30beb779: Added support for custom esbuild plugins
- 68d32429b: Capture and display stderr on index failures
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

- e04d44866: v3: sanitize errors with null unicode characters in some places
- 26093896d: When using idempotency keys, triggerAndWait and batchTriggerAndWait will still work even if the existing runs have already been completed (or even partially completed, in the case of batchTriggerAndWait)

  - TaskRunExecutionResult.id is now the run friendlyId, not the attempt friendlyId
  - A single TaskRun can now have many batchItems, in the case of batchTriggerAndWait while using idempotency keys
  - A run’s idempotencyKey is now added to the ctx as well as the TaskEvent and displayed in the span view
  - When resolving batchTriggerAndWait, the runtimes no longer reject promises, leading to an error in the parent task

- 55d1f8c67: Add callback to checkpoint created message
- c405ae711: Make deduplicationKey required when creating/updating a schedule
- 9e5382951: Improve the display of non-object return types in the run trace viewer
- b68012f81: Move to our global system from AsyncLocalStorage for the current task context storage
- 098932ea9: v3: vercel edge runtime support
- 68d32429b: - Fix uncaught provider exception
  - Remove unused provider messages
- 9835f4ec5: v3: fix otel flushing causing CLEANUP ack timeout errors by always setting a forceFlushTimeoutMillis value
- 3f8b6d8fc: v2: Better handle recovering from platform communication errors by auto-yielding back to the platform in case of temporary API failures
- fde939a30: Make optional schedule object fields nullish
- 1281d40e4: When a v2 run hits the rate limit, reschedule with the reset date
- ba71f959e: Management SDK overhaul and adding the runs.list API
- 03b104a3d: Added JSDocs to the schedule SDK types
- f93eae300: Dynamically import superjson and fix some bundling issues
- 5ae3da6b4: - Fix artifact detection logs
  - Fix OOM detection and error messages
  - Add test link to cli deployment completion
- c405ae711: Added timezone support to schedules
- 34ca7667d: v3: Include presigned urls for downloading large payloads and outputs when using runs.retrieve
- 8ba998794: Added declarative cron schedules
- 62c9a5b71: Fixes an issue that caused failed tasks when resuming after calling `triggerAndWait` or `batchTriggerAndWait` in prod/staging (this doesn't effect dev).

  The version of Node.js we use for deployed workers (latest 20) would crash with an out-of-memory error when the checkpoint was restored. This crash does not happen on Node 18x or Node21x, so we've decided to upgrade the worker version to Node.js21x, to mitigate this issue.

  You'll need to re-deploy to production to fix the issue.

- 392453e8a: Fix for when a log flush times out and the process is checkpointed
- 8578c9b28: Add remote forced externals system, in case we come across another package that cannot be bundled (spurred on by header-generator)
- 6a379e4e9: Fix 3rd party otel propagation from breaking our Task Events data from being properly correlated to the correct trace
- f854cb90e: Added cancelRun to the SDK
- 584c7da5d: - Add graceful exit for prod workers
  - Prevent overflow in long waits
- 4986bfda2: Added a new global - Task Catalog - to better handle task metadata
- e69ffd314: - Clear paused states before retry
  - Detect and handle unrecoverable worker errors
  - Remove checkpoints after successful push
  - Permanently switch to DO hosted busybox image
  - Fix IPC timeout issue, or at least handle it more gracefully
  - Handle checkpoint failures
  - Basic chaos monkey for checkpoint testing
  - Stack traces are back in the dashboard
  - Display final errors on root span
- b68012f81: Extracting out all the non-SDK related features from the main @trigger.dev/core/v3 export
- 39885a427: v3: fix missing init output in task run function when no middleware is defined
- 8578c9b28: fix node10 moduleResolution in @trigger.dev/core
- e69ffd314: Improve handling of IPC timeouts and fix checkpoint cancellation after failures
- 8578c9b28: Only import import-in-the-middle hook if there are instrumented packages
- f04041744: Support for custom conditions
- d934feb02: Add more package exports that can be used from the web app

## 3.0.0-beta.55

## 3.0.0-beta.54

## 3.0.0-beta.53

### Patch Changes

- 5cf90da72: Fix issues that could result in unreezable state run crashes. Details:
  - Never checkpoint between attempts
  - Some messages and socket data now include attempt numbers
  - Remove attempt completion replays
  - Additional prod entry point logging
  - Fail runs that receive deprecated (pre-lazy attempt) execute messages

## 3.0.0-beta.52

### Patch Changes

- 9882d66f8: Pre-pull deployment images for faster startups
- 09413a62a: Added version to ctx.run

## 3.0.0-beta.51

### Patch Changes

- 55264657d: You can now add tags to runs and list runs using them

## 3.0.0-beta.50

### Patch Changes

- 8ba998794: Added declarative cron schedules

## 3.0.0-beta.49

### Patch Changes

- dbda820a7: - Prevent uncaught exceptions when handling WebSocket messages
  - Improve CLI dev command WebSocket debug and error logging
- e417aca87: Added config option extraCACerts to ProjectConfig type. This copies the ca file along with additionalFiles and sets NODE_EXTRA_CA_CERTS environment variable in built image as well as running the task.
- d934feb02: Add more package exports that can be used from the web app

## 3.0.0-beta.48

## 3.0.0-beta.47

### Patch Changes

- 4f95c9de4: v3: recover from server rate limiting errors in a more reliable way
- e04d44866: v3: sanitize errors with null unicode characters in some places

## 3.0.0-beta.46

### Patch Changes

- 14c2bdf89: Tasks should now be much more robust and resilient to reconnects during crucial operations and other failure scenarios.

  Task runs now have to signal checkpointable state prior to ALL checkpoints. This ensures flushing always happens.

  All important socket.io RPCs will now be retried with backoff. Actions relying on checkpoints will be replayed if we haven't been checkpointed and restored as expected, e.g. after reconnect.

  Other changes:

  - Fix retry check in shared queue
  - Fix env var sync spinner
  - Heartbeat between retries
  - Fix retry prep
  - Fix prod worker no tasks detection
  - Fail runs above `MAX_TASK_RUN_ATTEMPTS`
  - Additional debug logs in all places
  - Prevent crashes due to failed socket schema parsing
  - Remove core-apps barrel
  - Upgrade socket.io-client to fix an ACK memleak
  - Additional index failure logs
  - Prevent message loss during reconnect
  - Prevent burst of heartbeats on reconnect
  - Prevent crash on failed cleanup
  - Handle at-least-once lazy execute message delivery
  - Handle uncaught entry point exceptions

## 3.0.0-beta.45

### Patch Changes

- 0e77e7ef7: v3: Trigger delayed runs and reschedule them
- 568da0178: - Improve non-zero exit code error messages
  - Detect OOM conditions within worker child processes
  - Internal errors can have optional stack traces
  - Docker provider can be set to enforce machine presets
- 5ae3da6b4: - Fix artifact detection logs
  - Fix OOM detection and error messages
  - Add test link to cli deployment completion

## 3.0.0-beta.44

### Patch Changes

- 39885a427: v3: fix missing init output in task run function when no middleware is defined

## 3.0.0-beta.43

### Patch Changes

- 34ca7667d: v3: Include presigned urls for downloading large payloads and outputs when using runs.retrieve

## 3.0.0-beta.42

## 3.0.0-beta.41

## 3.0.0-beta.40

### Patch Changes

- 55d1f8c67: Add callback to checkpoint created message
- 098932ea9: v3: vercel edge runtime support
- 9835f4ec5: v3: fix otel flushing causing CLEANUP ack timeout errors by always setting a forceFlushTimeoutMillis value

## 3.0.0-beta.39

## 3.0.0-beta.38

### Patch Changes

- 1b90ffbb8: v3: Usage tracking
- 0ed93a748: v3: Remove aggressive otel flush timeouts in dev/prod
- c405ae711: Make deduplicationKey required when creating/updating a schedule
- c405ae711: Added timezone support to schedules

## 3.0.0-beta.37

### Patch Changes

- 68d32429b: Capture and display stderr on index failures
- 68d32429b: - Fix uncaught provider exception
  - Remove unused provider messages

## 3.0.0-beta.36

### Patch Changes

- b4f9b70ae: Support triggering tasks with non-URL friendly characters in the ID
- ba71f959e: Management SDK overhaul and adding the runs.list API

## 3.0.0-beta.35

### Patch Changes

- ece6ca678: Fix issue when using SDK in non-node environments by scoping the stream import with node:
- e69ffd314: - Clear paused states before retry
  - Detect and handle unrecoverable worker errors
  - Remove checkpoints after successful push
  - Permanently switch to DO hosted busybox image
  - Fix IPC timeout issue, or at least handle it more gracefully
  - Handle checkpoint failures
  - Basic chaos monkey for checkpoint testing
  - Stack traces are back in the dashboard
  - Display final errors on root span
- e69ffd314: Improve handling of IPC timeouts and fix checkpoint cancellation after failures

## 3.0.0-beta.34

### Patch Changes

- 3a1b0c486: v3: Environment variable management API and SDK, along with resolveEnvVars CLI hook
- 3f8b6d8fc: v2: Better handle recovering from platform communication errors by auto-yielding back to the platform in case of temporary API failures
- 1281d40e4: When a v2 run hits the rate limit, reschedule with the reset date

## 3.0.0-beta.33

### Patch Changes

- 6a379e4e9: Fix 3rd party otel propagation from breaking our Task Events data from being properly correlated to the correct trace

## 3.0.0-beta.32

## 3.0.0-beta.31

## 3.0.0-beta.30

### Patch Changes

- 1477a2e30: Increased the timeout when canceling a checkpoint to 31s (to match the timeout on the server)
- 0e919f56f: Better handle uncaught exceptions

## 3.0.0-beta.29

## 3.0.0-beta.28

### Patch Changes

- d490bc5cb: Add the "log" level back in as an alias to "info"
- 6d9dfbc75: Add configure function to be able to configure the SDK manually

## 3.0.0-beta.27

### Patch Changes

- 1670c4c41: Remove "log" Log Level, unify log and info messages under the "info" log level
- 203e00208: Add runs.retrieve management API method to get info about a run by run ID

## 3.0.0-beta.26

## 3.0.0-beta.25

### Patch Changes

- e337b2165: Add a postInstall option to allow running scripts after dependencies have been installed in deployed images
- 9e5382951: Improve the display of non-object return types in the run trace viewer

## 3.0.0-beta.24

### Patch Changes

- 83dc87155: Fix issues with consecutive waits

## 3.0.0-beta.23

## 3.0.0-beta.22

## 3.0.0-beta.21

### Patch Changes

- 9491a1649: Implement task.onSuccess/onFailure and config.onSuccess/onFailure
- 9491a1649: Adds support for `emitDecoratorMetadata: true` and `experimentalDecorators: true` in your tsconfig using the [`@anatine/esbuild-decorators`](https://github.com/anatine/esbuildnx/tree/main/packages/esbuild-decorators) package. This allows you to use libraries like TypeORM:

  ```ts orm/index.ts
  import "reflect-metadata";
  import { DataSource } from "typeorm";
  import { Entity, Column, PrimaryColumn } from "typeorm";

  @Entity()
  export class Photo {
    @PrimaryColumn()
    id!: number;

    @Column()
    name!: string;

    @Column()
    description!: string;

    @Column()
    filename!: string;

    @Column()
    views!: number;

    @Column()
    isPublished!: boolean;
  }

  export const AppDataSource = new DataSource({
    type: "postgres",
    host: "localhost",
    port: 5432,
    username: "postgres",
    password: "postgres",
    database: "v3-catalog",
    entities: [Photo],
    synchronize: true,
    logging: false,
  });
  ```

  And then in your trigger.config.ts file you can initialize the datasource using the new `init` option:

  ```ts trigger.config.ts
  import type { TriggerConfig } from "@trigger.dev/sdk/v3";
  import { AppDataSource } from "@/trigger/orm";

  export const config: TriggerConfig = {
    // ... other options here
    init: async (payload, { ctx }) => {
      await AppDataSource.initialize();
    },
  };
  ```

  Now you are ready to use this in your tasks:

  ```ts
  import { task } from "@trigger.dev/sdk/v3";
  import { AppDataSource, Photo } from "./orm";

  export const taskThatUsesDecorators = task({
    id: "taskThatUsesDecorators",
    run: async (payload: { message: string }) => {
      console.log("Creating a photo...");

      const photo = new Photo();
      photo.id = 2;
      photo.name = "Me and Bears";
      photo.description = "I am near polar bears";
      photo.filename = "photo-with-bears.jpg";
      photo.views = 1;
      photo.isPublished = true;

      await AppDataSource.manager.save(photo);
    },
  });
  ```

## 3.0.0-beta.20

### Patch Changes

- e3db25739: Fix error stack traces

## 3.0.0-beta.19

## 3.0.0-beta.18

### Patch Changes

- b68012f81: Move to our global system from AsyncLocalStorage for the current task context storage
- b68012f81: Extracting out all the non-SDK related features from the main @trigger.dev/core/v3 export

## 3.0.0-beta.17

## 3.0.0-beta.16

### Patch Changes

- ed2a26c86: - Fix additionalFiles that aren't decendants
  - Stop swallowing uncaught exceptions in prod
  - Improve warnings and errors, fail early on critical warnings
  - New arg to --save-logs even for successful builds

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

- 62c9a5b71: Fixes an issue that caused failed tasks when resuming after calling `triggerAndWait` or `batchTriggerAndWait` in prod/staging (this doesn't effect dev).

  The version of Node.js we use for deployed workers (latest 20) would crash with an out-of-memory error when the checkpoint was restored. This crash does not happen on Node 18x or Node21x, so we've decided to upgrade the worker version to Node.js21x, to mitigate this issue.

  You'll need to re-deploy to production to fix the issue.

## 3.0.0-beta.14

### Patch Changes

- 584c7da5d: - Add graceful exit for prod workers
  - Prevent overflow in long waits

## 3.0.0-beta.13

### Patch Changes

- 4986bfda2: Add option to print console logs in the dev CLI locally (issue #1014)
- 44e1b8754: Improve the SDK function types and expose a new APIError instead of the APIResult type
- 4986bfda2: Adding task with a triggerSource of schedule
- fde939a30: Make optional schedule object fields nullish
- 03b104a3d: Added JSDocs to the schedule SDK types
- 4986bfda2: Added a new global - Task Catalog - to better handle task metadata

## 3.0.0-beta.12

## 3.0.0-beta.11

## 3.0.0-beta.7

### Patch Changes

- f854cb90e: Added replayRun function to the SDK
- f854cb90e: Added cancelRun to the SDK

## 3.0.0-beta.6

### Patch Changes

- 7ea8532cc: Display errors for runs and deployments

## 3.0.0-beta.5

### Patch Changes

- eb6012628: Fixed batch otel flushing

## 3.0.0-beta.4

## 3.0.0-beta.3

### Patch Changes

- c702d6a9c: better handle task metadata parse errors, and display nicely formatted errors
- b271742dc: Configurable log levels in the config file and via env var
- 9af2570da: Retry 429, 500, and connection error API requests to the trigger.dev server

## 3.0.0-beta.2

### Patch Changes

- e3cf456c6: Handle string and non-stringifiable outputs like functions

## 3.0.0-beta.1

### Patch Changes

- b66d5525e: add machine config and secure zod connection
- 719c0a0b9: Fixed incorrect span timings around checkpoints by implementing a precise wall clock that resets after restores
- f93eae300: Dynamically import superjson and fix some bundling issues

## 3.0.0-beta.0

### Major Changes

- 395abe1b9: Updates to support Trigger.dev v3

## 2.3.18

## 2.3.17

## 2.3.16

### Patch Changes

- 583da458: Changed the minimum interval time period from 60s to 20s

## 2.3.15

## 2.3.14

## 2.3.13

## 2.3.12

## 2.3.11

## 2.3.10

## 2.3.9

### Patch Changes

- 740b7b23: feat: Add $not to eventFilters

## 2.3.8

## 2.3.7

## 2.3.6

## 2.3.5

## 2.3.4

## 2.3.3

## 2.3.2

## 2.3.1

### Patch Changes

- f3efcc0c: Moved Logger to core-backend, no longer importing node:buffer in core/react

## 2.3.0

### Minor Changes

- 17f6f29d: Support for Deno, Bun and Cloudflare workers, as well as conditionally exporting ESM versions of the package instead of just commonjs.

  Cloudflare worker support requires the node compat flag turned on (https://developers.cloudflare.com/workers/runtime-apis/nodejs/)

## 2.2.11

## 2.2.10

## 2.2.9

### Patch Changes

- 6ebd435e: Feature: Run execution concurrency limits

## 2.2.8

### Patch Changes

- 067e19fe: - Simplify `Webhook Triggers` and use the new HTTP Endpoints
  - Add a `Key-Value Store` for use in and outside of Jobs
  - Add a `@trigger.dev/shopify` package

## 2.2.7

### Patch Changes

- 756024da: Add support for listening to run notifications

## 2.2.6

### Patch Changes

- cb1825bf: OpenAI support for 4.16.0
- cb1825bf: Add support for background polling and use that in OpenAI integration to power assistants
- d0217344: Add `io.sendEvents()`

## 2.2.5

### Patch Changes

- 620b8383: Added invokeTrigger(), which allows jobs to be manually invoked
- 578d2e54: Fixed Buffer reference error

## 2.2.4

### Patch Changes

- c1710ae7: Creates a new package @trigger.dev/core-backend that includes code shared between @trigger.dev/sdk and the Trigger.dev server

## 2.2.3

### Patch Changes

- 6e1b8a11: implement functionality to cancel job runs triggered by a given eventId.

## 2.2.2

## 2.2.1

### Patch Changes

- 044d38e3: Auto-yield run execution to help prevent duplicate task executions
- abc9737a: Updated icon documentation in runTasks

## 2.2.0

### Minor Changes

- 975c5f1d: Drop support for Node v16, require Node >= 18. This allows us to use native fetch in our SDK which paves the way for multi-platform support.

### Patch Changes

- 50e3d9e4: When indexing user's jobs errors are now stored and displayed
- 59a94c71: Allow task property values to be blank, but strip them out before persisting them

## 2.1.9

### Patch Changes

- 9a187f9e: upgrade zod to 3.22.3

## 2.1.8

### Patch Changes

- 6a992a19: First release of `@trigger.dev/replicate` integration with remote callback support.
- ab9e4a98: Send client version back to the server via headers
- ab9e4a98: Better performance when resuming a run, especially one with a large amount of tasks

## 2.1.7

## 2.1.6

## 2.1.5

## 2.1.4

### Patch Changes

- ad14983e: You can create statuses in your Jobs that can then be read using React hooks
- 50137a6f: Decouple zod
- c0dfa804: Add support for Bring Your Own Auth

## 2.1.3

## 2.1.2

## 2.1.1

## 2.1.0

### Minor Changes

- Integrations are now simpler and support authentication during webhook registration ([`878da3c0`](https://github.com/triggerdotdev/trigger.dev/commit/878da3c01f0a4dfaf33a1f8943a7ad4eed8b8877))

## 2.1.0-beta.1

## 2.1.0-beta.0

### Minor Changes

- Integrations are now simpler and support authentication during webhook registration ([`878da3c0`](https://github.com/triggerdotdev/trigger.dev/commit/878da3c01f0a4dfaf33a1f8943a7ad4eed8b8877))

## 2.0.14

## 2.0.13

## 2.0.12

## 2.0.11

### Patch Changes

- 302bd02f: Issue #377: only expose the external eventId in the API
- b5db9f5e: Adding MIT license

## 2.0.10

### Patch Changes

- b1b9321a: Deprecated queue options in the job and removed startPosition

## 2.0.9

### Patch Changes

- 33184a81: Add subtasks to the schema/types when getting an individual run

## 2.0.8

## 2.0.7

### Patch Changes

- fa3a22eb: Added an $isNull EventFilter condition matcher

## 2.0.6

### Patch Changes

- 59075f5f: EventFilter now supports more complex condition filters #271

## 2.0.5

## 2.0.4

### Patch Changes

- 96384991: Adding the validate endpoint action to be able to add an endpoint first in the dashboard

## 2.0.3

## 2.0.2

### Patch Changes

- 0a790de2: core version changed to 1.0.0. Dependencies for core set to ^1.0.0
- ee99191f: Sync all package versions

## 0.0.5

### Patch Changes

- aa9fe7d4: core made public. The react and sdk packages now have it as a dependency.

## 0.0.4

### Patch Changes

- 92233f2e: @trigger.dev/core is now a separate package
- 92233f2e: Packages move to @latest
- e26923eb: backgroundFetch jsdocs

## 0.0.2-next.1

### Patch Changes

- e26923eb: backgroundFetch jsdocs

## 0.0.2-next.0

### Patch Changes

- a11ddf65: Added JSDocs related to logging

## 0.0.3

### Patch Changes

- 6673798: Bundling common-schemas into @trigger.dev/sdk
- Updated dependencies [6673798]
  - @trigger.dev/core@0.1.1

## 0.0.2

### Patch Changes

- Updated dependencies [92dd011]
  - @trigger.dev/core@0.1.0
