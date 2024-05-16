# trigger.dev

## 3.0.0-beta.33

### Patch Changes

- 598906fc4: Fix for typo in v3 CLI login command
- Updated dependencies [6a379e4e9]
  - @trigger.dev/core@3.0.0-beta.33

## 3.0.0-beta.32

### Patch Changes

- f96f1e91a: Better handle issues with resolving dependency versions during deploy
  - @trigger.dev/core@3.0.0-beta.32

## 3.0.0-beta.31

### Patch Changes

- b8477ea2b: Fixes an issue with scoped packages in additionalPackages option
  - @trigger.dev/core@3.0.0-beta.31

## 3.0.0-beta.30

### Patch Changes

- 0e919f56f: Better handle uncaught exceptions
- Updated dependencies [1477a2e30]
- Updated dependencies [0e919f56f]
  - @trigger.dev/core@3.0.0-beta.30

## 3.0.0-beta.29

### Patch Changes

- @trigger.dev/core@3.0.0-beta.29

## 3.0.0-beta.28

### Patch Changes

- 2156e1526: Adding some additional telemetry during deploy to help debug issues
- 6406924b0: Ensure @trigger.dev/sdk and @trigger.dev/core are always in the list of deployed dependencies
- Updated dependencies [d490bc5cb]
- Updated dependencies [6d9dfbc75]
  - @trigger.dev/core@3.0.0-beta.28

## 3.0.0-beta.27

### Patch Changes

- 1670c4c41: Remove "log" Log Level, unify log and info messages under the "info" log level
- Updated dependencies [1670c4c41]
- Updated dependencies [203e00208]
  - @trigger.dev/core@3.0.0-beta.27

## 3.0.0-beta.26

### Patch Changes

- e667028d4: Strip out server-only package from worker builds
  - @trigger.dev/core@3.0.0-beta.26

## 3.0.0-beta.25

### Patch Changes

- e337b2165: Add a postInstall option to allow running scripts after dependencies have been installed in deployed images
- c37c82231: Use locked package versions when resolving dependencies in deployed workers
- Updated dependencies [e337b2165]
- Updated dependencies [9e5382951]
  - @trigger.dev/core@3.0.0-beta.25

## 3.0.0-beta.24

### Patch Changes

- 83dc87155: Fix issues with consecutive waits
- Updated dependencies [83dc87155]
  - @trigger.dev/core@3.0.0-beta.24

## 3.0.0-beta.23

### Patch Changes

- 43bc7ed94: Hoist uncaughtException handler to the top of workers to better report error messages
  - @trigger.dev/core@3.0.0-beta.23

## 3.0.0-beta.22

### Patch Changes

- ebeb79052: Add typescript as a dependency so the esbuild-decorator will work even when running in npx
  - @trigger.dev/core@3.0.0-beta.22

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

- Updated dependencies [9491a1649]
- Updated dependencies [9491a1649]
  - @trigger.dev/core@3.0.0-beta.21

## 3.0.0-beta.20

### Patch Changes

- de1cc868e: Fix dev CLI output when not printing update messages
- Updated dependencies [e3db25739]
  - @trigger.dev/core@3.0.0-beta.20

## 3.0.0-beta.19

### Patch Changes

- e9a63a486: Lock SDK and CLI deps on exact core version
  - @trigger.dev/core@3.0.0-beta.19

## 3.0.0-beta.18

### Patch Changes

- b68012f81: Remove the env var check during deploy (too many false negatives)
- b68012f81: Fixes an issue that was treating v2 trigger directories as v3
- 74d1e61e4: Fix a bug where revoking the CLI token would prevent you from ever logging in again with the CLI.
- 52b2a8289: Add git to prod worker image which fixes private package installs
- b68012f81: Move to our global system from AsyncLocalStorage for the current task context storage
- b68012f81: Extracting out all the non-SDK related features from the main @trigger.dev/core/v3 export
- b68012f81: Add support for tasks located in subdirectories inside trigger dirs
- Updated dependencies [b68012f81]
- Updated dependencies [b68012f81]
  - @trigger.dev/core@3.0.0-beta.18

## 3.0.0-beta.17

### Patch Changes

- b20760173: v3 CLI update command and package manager detection fix
  - @trigger.dev/core@3.0.0-beta.17

## 3.0.0-beta.16

### Patch Changes

- ed2a26c86: - Fix additionalFiles that aren't decendants
  - Stop swallowing uncaught exceptions in prod
  - Improve warnings and errors, fail early on critical warnings
  - New arg to --save-logs even for successful builds
- Updated dependencies [ed2a26c86]
  - @trigger.dev/core@3.0.0-beta.16

## 3.0.0-beta.15

### Patch Changes

- 26093896d: When using idempotency keys, triggerAndWait and batchTriggerAndWait will still work even if the existing runs have already been completed (or even partially completed, in the case of batchTriggerAndWait)

  - TaskRunExecutionResult.id is now the run friendlyId, not the attempt friendlyId
  - A single TaskRun can now have many batchItems, in the case of batchTriggerAndWait while using idempotency keys
  - A run’s idempotencyKey is now added to the ctx as well as the TaskEvent and displayed in the span view
  - When resolving batchTriggerAndWait, the runtimes no longer reject promises, leading to an error in the parent task

- b82db67b8: Add additional logging around cleaning up dev workers, and always kill them after 5 seconds if they haven't already exited
- 62c9a5b71: Fixes an issue that caused failed tasks when resuming after calling `triggerAndWait` or `batchTriggerAndWait` in prod/staging (this doesn't effect dev).

  The version of Node.js we use for deployed workers (latest 20) would crash with an out-of-memory error when the checkpoint was restored. This crash does not happen on Node 18x or Node21x, so we've decided to upgrade the worker version to Node.js21x, to mitigate this issue.

  You'll need to re-deploy to production to fix the issue.

- Updated dependencies [374edef02]
- Updated dependencies [26093896d]
- Updated dependencies [62c9a5b71]
  - @trigger.dev/core@3.0.0-beta.15

## 3.0.0-beta.14

### Patch Changes

- 584c7da5d: - Add graceful exit for prod workers
  - Prevent overflow in long waits
- Updated dependencies [584c7da5d]
  - @trigger.dev/core@3.0.0-beta.14

## 3.0.0-beta.13

### Patch Changes

- 4986bfda2: Add option to print console logs in the dev CLI locally (issue #1014)
- 4986bfda2: Adding task with a triggerSource of schedule
- 4986bfda2: Added a new global - Task Catalog - to better handle task metadata
- Updated dependencies [4986bfda2]
- Updated dependencies [44e1b8754]
- Updated dependencies [4986bfda2]
- Updated dependencies [fde939a30]
- Updated dependencies [03b104a3d]
- Updated dependencies [4986bfda2]
  - @trigger.dev/core@3.0.0-beta.13

## 3.0.0-beta.12

### Patch Changes

- d3a18fbdf: Fix package builds and CLI commands on Windows
- d3a18fbdf: Init command was failing on Windows because of bad template paths
  - @trigger.dev/core@3.0.0-beta.12

## 3.0.0-beta.11

### Patch Changes

- 63a643b7c: v3: fix digest extraction
  - @trigger.dev/core@3.0.0-beta.11

## 3.0.0-beta.10

### Patch Changes

- 7a9bd18ba: Stop swallowing deployment errors and display them better

## 3.0.0-beta.9

### Patch Changes

- 279717b09: Don’t swallow some error messages when deploying
- 328947dbf: Use the dashboard url instead of the API url for the View logs link

## 3.0.0-beta.8

### Patch Changes

- 1c24348f7: Add openssl to prod worker image and allow passing auth token via env var for deploy
- Updated dependencies [f854cb90e]
- Updated dependencies [f854cb90e]
  - @trigger.dev/core@3.0.0-beta.7

## 3.0.0-beta.7

### Patch Changes

- 624ddce32: Fix permissions inside node_modules
- 9be1557bb: Changed the binary name from trigger.dev to triggerdev to fix a Windows issue

## 3.0.0-beta.6

### Patch Changes

- 7ea8532cc: Display errors for runs and deployments
- 1207efbba: Correctly handle self-hosted deploy command errors
- e35f29764: Default to retrying enabled in dev when running init
- f2894c177: Fix post start hooks
- 6dcfeadac: Fixing an issue with bundling @trigger.dev/core/v3 in dev when using pnpm
- Updated dependencies [7ea8532cc]
  - @trigger.dev/core@3.0.0-beta.6

## 3.0.0-beta.5

### Patch Changes

- 49184c718: Update trigger.dev CLI for new batch otel support
- Updated dependencies [eb6012628]
  - @trigger.dev/core@3.0.0-beta.5

## 3.0.0-beta.4

### Patch Changes

- c702d6a9c: better handle task metadata parse errors, and display nicely formatted errors
- b271742dc: Configurable log levels in the config file and via env var
- 8c4df326c: Improve error messages during dev/deploy and handle deploy image build issues
- b271742dc: Added a Node.js runtime check for the CLI
- 8694e573f: Fix CLI logout and add list-profiles command
- Updated dependencies [c702d6a9c]
- Updated dependencies [b271742dc]
- Updated dependencies [9af2570da]
  - @trigger.dev/core@3.0.0-beta.3

## 3.0.0-beta.3

### Patch Changes

- e3cf456c6: Handle string and non-stringifiable outputs like functions
- Updated dependencies [e3cf456c6]
  - @trigger.dev/core@3.0.0-beta.2

## 3.0.0-beta.2

### Patch Changes

- b66d5525e: add machine config and secure zod connection
- d9c9e80bc: Changed "Worker" to "Version" in the dev command key
- 719c0a0b9: Fixed incorrect span timings around checkpoints by implementing a precise wall clock that resets after restores
- 9bcb8cb42: Added DEBUG to the ignored env vars
- f93eae300: Dynamically import superjson and fix some bundling issues
- Updated dependencies [b66d5525e]
- Updated dependencies [719c0a0b9]
- Updated dependencies [f93eae300]
  - @trigger.dev/core@3.0.0-beta.1

## 3.0.0-beta.1

### Patch Changes

- f1571cbfa: Fixed an issue where the trigger.dev package was not being built before publishing to npm

## 3.0.0-beta.0

### Major Changes

- 395abe1b9: Updates to support Trigger.dev v3

### Patch Changes

- 5b745dc1a: Vastly improved dev command output
- Updated dependencies [395abe1b9]
  - @trigger.dev/core@3.0.0-beta.0

## 1.0.7

### Patch Changes

- @trigger.dev/core@2.3.18

## 1.0.6

### Patch Changes

- @trigger.dev/core@2.3.17

## 1.0.5

### Patch Changes

- Updated dependencies [583da458]
  - @trigger.dev/core@2.3.16

## 1.0.4

### Patch Changes

- @trigger.dev/core@2.3.15

## 1.0.3

### Patch Changes

- @trigger.dev/core@2.3.14

## 1.0.2

### Patch Changes

- @trigger.dev/core@2.3.13

## 1.0.1

### Patch Changes

- @trigger.dev/core@2.3.12
