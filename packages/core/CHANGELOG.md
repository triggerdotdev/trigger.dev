# internal-platform

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
