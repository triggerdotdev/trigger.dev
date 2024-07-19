# internal-platform

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
