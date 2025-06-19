# trigger.dev

## 4.0.0-v4-beta.22

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.22`
  - `@trigger.dev/build@4.0.0-v4-beta.22`

## 4.0.0-v4-beta.21

### Patch Changes

- Runtime agnostic SDK config via env vars ([#2132](https://github.com/triggerdotdev/trigger.dev/pull/2132))
- Fix update command version range handling ([#2153](https://github.com/triggerdotdev/trigger.dev/pull/2153))
- - Resolve issue where CLI could get stuck during deploy finalization ([#2138](https://github.com/triggerdotdev/trigger.dev/pull/2138))
  - Unify local and remote build logic, with multi-platform build support
  - Improve switch command; now accepts profile name as an argument
  - Registry configuration is now fully managed by the webapp
  - The deploy `--self-hosted` flag is no longer required
  - Enhance deployment error reporting and image digest retrieval
- Update profile switcher ([#2150](https://github.com/triggerdotdev/trigger.dev/pull/2150))
- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.21`
  - `@trigger.dev/build@4.0.0-v4-beta.21`

## 4.0.0-v4-beta.20

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/build@4.0.0-v4-beta.20`
  - `@trigger.dev/core@4.0.0-v4-beta.20`

## 4.0.0-v4-beta.19

### Patch Changes

- Add import timings and bundle size analysis, the dev command will now warn about slow imports ([#2114](https://github.com/triggerdotdev/trigger.dev/pull/2114))
- Fix metadata collapsing correctness ([#2115](https://github.com/triggerdotdev/trigger.dev/pull/2115))
- Added support for Preview branches in v4 projects ([#2086](https://github.com/triggerdotdev/trigger.dev/pull/2086))
- Can now set project ref using the TRIGGER_PROJECT_REF env var ([#2109](https://github.com/triggerdotdev/trigger.dev/pull/2109))
- Fix `syncEnvVars` for non-preview deployments ([#2131](https://github.com/triggerdotdev/trigger.dev/pull/2131))
- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.19`
  - `@trigger.dev/build@4.0.0-v4-beta.19`

## 4.0.0-v4-beta.18

### Patch Changes

- Fix dev runs ([#2094](https://github.com/triggerdotdev/trigger.dev/pull/2094))
- Updated dependencies:
  - `@trigger.dev/build@4.0.0-v4-beta.18`
  - `@trigger.dev/core@4.0.0-v4-beta.18`

## 4.0.0-v4-beta.17

### Patch Changes

- Expose esbuild `keepNames` option (experimental) ([#2091](https://github.com/triggerdotdev/trigger.dev/pull/2091))
- Add `experimental_autoDetectExternal` trigger config option ([#2083](https://github.com/triggerdotdev/trigger.dev/pull/2083))
- Output esbuild metafile, can be inspected after `deploy --dry run` ([#2087](https://github.com/triggerdotdev/trigger.dev/pull/2087))
- Expose esbuild `minify` option (experimental) ([#2091](https://github.com/triggerdotdev/trigger.dev/pull/2091))
- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.17`
  - `@trigger.dev/build@4.0.0-v4-beta.17`

## 4.0.0-v4-beta.16

### Patch Changes

- Fix init.ts detection when using the sentry esbuild plugin ([#2051](https://github.com/triggerdotdev/trigger.dev/pull/2051))
- Updated dependencies:
  - `@trigger.dev/build@4.0.0-v4-beta.16`
  - `@trigger.dev/core@4.0.0-v4-beta.16`

## 4.0.0-v4-beta.15

### Patch Changes

- Add external log exporters and fix missing external trace exporters in deployed tasks ([#2038](https://github.com/triggerdotdev/trigger.dev/pull/2038))
- Log images sizes for self-hosted deploys ([#1764](https://github.com/triggerdotdev/trigger.dev/pull/1764))
- Fix init.ts auto-import for deployed workers ([#2041](https://github.com/triggerdotdev/trigger.dev/pull/2041))
- Updated dependencies:
  - `@trigger.dev/build@4.0.0-v4-beta.15`
  - `@trigger.dev/core@4.0.0-v4-beta.15`

## 4.0.0-v4-beta.14

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/build@4.0.0-v4-beta.14`
  - `@trigger.dev/core@4.0.0-v4-beta.14`

## 4.0.0-v4-beta.13

### Patch Changes

- - Correctly resolve waitpoints that come in early ([#2006](https://github.com/triggerdotdev/trigger.dev/pull/2006))
  - Ensure correct state before requesting suspension
  - Fix race conditions in snapshot processing
- Always print full deploy logs in CI ([#2006](https://github.com/triggerdotdev/trigger.dev/pull/2006))
- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.13`
  - `@trigger.dev/build@4.0.0-v4-beta.13`

## 4.0.0-v4-beta.12

### Patch Changes

- Display clickable links in Cursor terminal ([#1998](https://github.com/triggerdotdev/trigger.dev/pull/1998))
- Added AI assistance link when you have build errors ([#1925](https://github.com/triggerdotdev/trigger.dev/pull/1925))
- If you pass a directory when calling deploy we validate it exists and give helpful hints ([#2013](https://github.com/triggerdotdev/trigger.dev/pull/2013))
- Updated dependencies:
  - `@trigger.dev/build@4.0.0-v4-beta.12`
  - `@trigger.dev/core@4.0.0-v4-beta.12`

## 4.0.0-v4-beta.11

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/build@4.0.0-v4-beta.11`
  - `@trigger.dev/core@4.0.0-v4-beta.11`

## 4.0.0-v4-beta.10

### Patch Changes

- TriggerApiError 4xx errors will no longer cause tasks to be retried ([#1970](https://github.com/triggerdotdev/trigger.dev/pull/1970))
- - Fix polling interval reset bug that could create duplicate intervals ([#1987](https://github.com/triggerdotdev/trigger.dev/pull/1987))
  - Protect against unexpected attempt number changes
  - Prevent run execution zombies after warm starts
- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.10`
  - `@trigger.dev/build@4.0.0-v4-beta.10`

## 4.0.0-v4-beta.9

### Patch Changes

- fix: default machine config indexing now works ([#1979](https://github.com/triggerdotdev/trigger.dev/pull/1979))
- Updated dependencies:
  - `@trigger.dev/build@4.0.0-v4-beta.9`
  - `@trigger.dev/core@4.0.0-v4-beta.9`

## 4.0.0-v4-beta.8

### Patch Changes

- Prevent large outputs from overwriting each other ([#1971](https://github.com/triggerdotdev/trigger.dev/pull/1971))
- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.8`
  - `@trigger.dev/build@4.0.0-v4-beta.8`

## 4.0.0-v4-beta.7

### Patch Changes

- Fixes runLimiter check on #dequeueRuns ([#1953](https://github.com/triggerdotdev/trigger.dev/pull/1953))
- Fix QUEUED status snapshot handler ([#1963](https://github.com/triggerdotdev/trigger.dev/pull/1963))
- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.7`
  - `@trigger.dev/build@4.0.0-v4-beta.7`

## 4.0.0-v4-beta.6

### Patch Changes

- The dev command will now use the platform-provided engine URL ([#1949](https://github.com/triggerdotdev/trigger.dev/pull/1949))
- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.6`
  - `@trigger.dev/build@4.0.0-v4-beta.6`

## 4.0.0-v4-beta.5

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/build@4.0.0-v4-beta.5`
  - `@trigger.dev/core@4.0.0-v4-beta.5`

## 4.0.0-v4-beta.4

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/build@4.0.0-v4-beta.4`
  - `@trigger.dev/core@4.0.0-v4-beta.4`

## 4.0.0-v4-beta.3

### Patch Changes

- Improve usage flushing ([#1931](https://github.com/triggerdotdev/trigger.dev/pull/1931))
- Fix stalled run detection ([#1934](https://github.com/triggerdotdev/trigger.dev/pull/1934))
- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.3`
  - `@trigger.dev/build@4.0.0-v4-beta.3`

## 4.0.0-v4-beta.2

### Patch Changes

- Managed run controller performance and reliability improvements ([#1927](https://github.com/triggerdotdev/trigger.dev/pull/1927))
- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.2`
  - `@trigger.dev/build@4.0.0-v4-beta.2`

## 4.0.0-v4-beta.1

### Patch Changes

- Fix init.ts in custom trigger dirs ([#1914](https://github.com/triggerdotdev/trigger.dev/pull/1914))
- Init command will now correctly install v4-beta packages ([#1914](https://github.com/triggerdotdev/trigger.dev/pull/1914))
- Update nypm package to support test-based bun.lock files ([#1914](https://github.com/triggerdotdev/trigger.dev/pull/1914))
- Handle flush errors gracefully in dev ([#1914](https://github.com/triggerdotdev/trigger.dev/pull/1914))
- Updated dependencies:
  - `@trigger.dev/build@4.0.0-v4-beta.1`
  - `@trigger.dev/core@4.0.0-v4-beta.1`

## 4.0.0-v4-beta.0

### Major Changes

- Trigger.dev v4 release. Please see our upgrade to v4 docs to view the full changelog: https://trigger.dev/docs/upgrade-to-v4 ([#1869](https://github.com/triggerdotdev/trigger.dev/pull/1869))

### Patch Changes

- Run Engine 2.0 (alpha) ([#1575](https://github.com/triggerdotdev/trigger.dev/pull/1575))
- Improve warm start times by eagerly creating the child TaskRunProcess when a previous run as completed ([#1879](https://github.com/triggerdotdev/trigger.dev/pull/1879))
- v4: New lifecycle hooks ([#1817](https://github.com/triggerdotdev/trigger.dev/pull/1817))
- Updated dependencies:
  - `@trigger.dev/build@4.0.0-v4-beta.0`
  - `@trigger.dev/core@4.0.0-v4-beta.0`

## 3.3.17

### Patch Changes

- Add support for two-phase deployments and task version pinning ([#1739](https://github.com/triggerdotdev/trigger.dev/pull/1739))
- Fix issue where a typescript file with only types causes indexing to fail ([#1735](https://github.com/triggerdotdev/trigger.dev/pull/1735))
- Upgrade @clack/prompts to 0.10.0 to fix CI output ([#1740](https://github.com/triggerdotdev/trigger.dev/pull/1740))
- Fixes needsPromotion github action output ([#1741](https://github.com/triggerdotdev/trigger.dev/pull/1741))
- Updated dependencies:
  - `@trigger.dev/core@3.3.17`
  - `@trigger.dev/build@3.3.17`

## 3.3.16

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/build@3.3.16`
  - `@trigger.dev/core@3.3.16`

## 3.3.15

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/build@3.3.15`
  - `@trigger.dev/core@3.3.15`

## 3.3.14

### Patch Changes

- Auto-fix /trigger or /src/trigger config.dirs to relative paths to prevent misconfiguration from preventing dev CLI from working ([#1665](https://github.com/triggerdotdev/trigger.dev/pull/1665))
- Updated dependencies:
  - `@trigger.dev/build@3.3.14`
  - `@trigger.dev/core@3.3.14`

## 3.3.13

### Patch Changes

- Fix "No tasks defined" issue because of misconfigured dir search paths. Also improve errors around no files or no tasks found during in dev" ([#1663](https://github.com/triggerdotdev/trigger.dev/pull/1663))
- Fixed deploy timeout issues and improve the output of logs when deploying ([#1661](https://github.com/triggerdotdev/trigger.dev/pull/1661))
- Updated dependencies:
  - `@trigger.dev/core@3.3.13`
  - `@trigger.dev/build@3.3.13`

## 3.3.12

### Patch Changes

- Fix broken cloud deploys by using depot ephemeral registry ([#1637](https://github.com/triggerdotdev/trigger.dev/pull/1637))
- Updated dependencies:
  - `@trigger.dev/core@3.3.12`
  - `@trigger.dev/build@3.3.12`

## 3.3.11

### Patch Changes

- Add otel exporter support ([#1602](https://github.com/triggerdotdev/trigger.dev/pull/1602))
- Require maxDuration config and have a better error for bad CI tokens ([#1620](https://github.com/triggerdotdev/trigger.dev/pull/1620))
- Updated dependencies:
  - `@trigger.dev/core@3.3.11`
  - `@trigger.dev/build@3.3.11`

## 3.3.10

### Patch Changes

- Support ignoring test/spec files inside trigger dirs (fixes #1593) ([#1596](https://github.com/triggerdotdev/trigger.dev/pull/1596))
- cleanup deprecated background worker files (fixes #1572) ([#1595](https://github.com/triggerdotdev/trigger.dev/pull/1595))
- Updated dependencies:
  - `@trigger.dev/core@3.3.10`
  - `@trigger.dev/build@3.3.10`

## 3.3.9

### Patch Changes

- Increase the number of active streams from 2 to 5, total streams from 5 to 10 ([#1563](https://github.com/triggerdotdev/trigger.dev/pull/1563))
- Adding ability to update parent run metadata from child runs/tasks ([#1563](https://github.com/triggerdotdev/trigger.dev/pull/1563))
- Updated dependencies:
  - `@trigger.dev/core@3.3.9`
  - `@trigger.dev/build@3.3.9`

## 3.3.8

### Patch Changes

- Fix externals from monorepo packages with scoped package names #1552 ([#1569](https://github.com/triggerdotdev/trigger.dev/pull/1569))
- fix: add user-agent to the websocket request ([#1584](https://github.com/triggerdotdev/trigger.dev/pull/1584))
- Updated dependencies:
  - `@trigger.dev/core@3.3.8`
  - `@trigger.dev/build@3.3.8`

## 3.3.7

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/build@3.3.7`
  - `@trigger.dev/core@3.3.7`

## 3.3.6

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.6`
  - `@trigger.dev/build@3.3.6`

## 3.3.5

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.5`
  - `@trigger.dev/build@3.3.5`

## 3.3.4

### Patch Changes

- Fix SDK version in build manifest for out-of-sync detection ([#1530](https://github.com/triggerdotdev/trigger.dev/pull/1530))
- Updated dependencies:
  - `@trigger.dev/build@3.3.4`
  - `@trigger.dev/core@3.3.4`

## 3.3.3

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.3`
  - `@trigger.dev/build@3.3.3`

## 3.3.2

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/build@3.3.2`
  - `@trigger.dev/core@3.3.2`

## 3.3.1

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/build@3.3.1`
  - `@trigger.dev/core@3.3.1`

## 3.3.0

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

- Updated dependencies:
  - `@trigger.dev/core@3.3.0`
  - `@trigger.dev/build@3.3.0`

## 3.2.2

### Patch Changes

- Prevent certain log statements from hanging deployed worker processes ([#1501](https://github.com/triggerdotdev/trigger.dev/pull/1501))
- Updated dependencies:
  - `@trigger.dev/build@3.2.2`
  - `@trigger.dev/core@3.2.2`

## 3.2.1

### Patch Changes

- Upgrade zod to latest (3.23.8) ([#1484](https://github.com/triggerdotdev/trigger.dev/pull/1484))
- feat: exit if docker buildx can't be found for self-hosted builds ([#1475](https://github.com/triggerdotdev/trigger.dev/pull/1475))
- Realtime streams ([#1470](https://github.com/triggerdotdev/trigger.dev/pull/1470))
- Updated dependencies:
  - `@trigger.dev/build@3.2.1`
  - `@trigger.dev/core@3.2.1`

## 3.2.0

### Patch Changes

- fix: unintended project initialization at absolute path `/trigger` during project initialization ([#1412](https://github.com/triggerdotdev/trigger.dev/pull/1412))
- Updated dependencies:
  - `@trigger.dev/build@3.2.0`
  - `@trigger.dev/core@3.2.0`

## 3.1.2

### Patch Changes

- Ignore duplicate dependency resume messages in deployed tasks ([#1459](https://github.com/triggerdotdev/trigger.dev/pull/1459))
- Improve resume reliability by replaying ready signal of restored workers ([#1458](https://github.com/triggerdotdev/trigger.dev/pull/1458))
- Updated dependencies:
  - `@trigger.dev/build@3.1.2`
  - `@trigger.dev/core@3.1.2`

## 3.1.1

### Patch Changes

- Increase max retry count for deploy run controller operations ([#1450](https://github.com/triggerdotdev/trigger.dev/pull/1450))
- Set parent PATH on forked worker processes ([#1448](https://github.com/triggerdotdev/trigger.dev/pull/1448))
- Updated dependencies:
  - `@trigger.dev/core@3.1.1`
  - `@trigger.dev/build@3.1.1`

## 3.1.0

### Patch Changes

- Fix issue with prisma extension breaking deploy builds ([#1429](https://github.com/triggerdotdev/trigger.dev/pull/1429))
- - Include retries.default in task retry config when indexing ([#1424](https://github.com/triggerdotdev/trigger.dev/pull/1424))
  - New helpers for internal error retry mechanics
  - Detection for segfaults and ffmpeg OOM errors
  - Retries for packet import and export
- Updated dependencies:
  - `@trigger.dev/core@3.1.0`
  - `@trigger.dev/build@3.1.0`

## 3.0.13

### Patch Changes

- README updates ([#1408](https://github.com/triggerdotdev/trigger.dev/pull/1408))
- Fix an IPC bug when using bun by pinning to an older version. ([#1409](https://github.com/triggerdotdev/trigger.dev/pull/1409))
- Updated dependencies:
  - `@trigger.dev/core@3.0.13`
  - `@trigger.dev/build@3.0.13`

## 3.0.12

### Patch Changes

- Remove (unused) path arg from the CLI dev command ([#1395](https://github.com/triggerdotdev/trigger.dev/pull/1395))
- Prettier and more specific errors with links to docs ([#1387](https://github.com/triggerdotdev/trigger.dev/pull/1387))
- Correctly display errors on attempts and during indexing ([#1397](https://github.com/triggerdotdev/trigger.dev/pull/1397))
- Updated dependencies:
  - `@trigger.dev/core@3.0.12`
  - `@trigger.dev/build@3.0.12`

## 3.0.11

### Patch Changes

- Fix downgrade check by correctly comparing semvers ([#1380](https://github.com/triggerdotdev/trigger.dev/pull/1380))
- Local env files like `.env` will now correctly override dev env vars configured in the dashboard ([#1388](https://github.com/triggerdotdev/trigger.dev/pull/1388))
- Always include push output in logs for self-hosted deploys ([#1382](https://github.com/triggerdotdev/trigger.dev/pull/1382))
- Updated dependencies:
  - `@trigger.dev/build@3.0.11`
  - `@trigger.dev/core@3.0.11`

## 3.0.10

### Patch Changes

- Adding maxDuration to tasks to allow timing out runs after they exceed a certain number of seconds ([#1377](https://github.com/triggerdotdev/trigger.dev/pull/1377))
- Updated dependencies:
  - `@trigger.dev/core@3.0.10`
  - `@trigger.dev/build@3.0.10`

## 3.0.9

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.0.9`
  - `@trigger.dev/build@3.0.9`

## 3.0.8

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/build@3.0.8`
  - `@trigger.dev/core@3.0.8`

## 3.0.7

### Patch Changes

- Fix resolving external packages that are ESM only by falling back to mlly resolvePathSync. This will fix mupdf ([#1346](https://github.com/triggerdotdev/trigger.dev/pull/1346))
- Add the "dev.vars" file to the list of auto-loaded dotenv files in the dev CLI command ([#1340](https://github.com/triggerdotdev/trigger.dev/pull/1340))
- Updated dependencies:
  - `@trigger.dev/build@3.0.7`
  - `@trigger.dev/core@3.0.7`

## 3.0.6

### Patch Changes

- 64862db84: Ignore OTEL_EXPORTER_OTLP_ENDPOINT environment variable from `.env` files, to prevent the internal OTEL_EXPORTER_OTLP_ENDPOINT being overwritten with a user-supplied value.
- b4be73655: prismaExtension fixes for #1325 and #1327
- Updated dependencies [b4be73655]
- Updated dependencies [4e0bc485a]
- Updated dependencies [c65d4822b]
- Updated dependencies [1f5bcc73b]
  - @trigger.dev/build@3.0.6
  - @trigger.dev/core@3.0.6

## 3.0.5

### Patch Changes

- 3b1522445: Apply default machine preset in config
- 3b1522445: Add additional error message and stack trace when a task file cannot be imported for run
  - @trigger.dev/build@3.0.5
  - @trigger.dev/core@3.0.5

## 3.0.4

### Patch Changes

- 8d1e41693: - Improve index error logging
  - Add network flag for self-hosted deploys
  - Fix checksum flag on some docker versions
  - Add Containerfile debug logs
- Updated dependencies [4adc773c7]
  - @trigger.dev/core@3.0.4
  - @trigger.dev/build@3.0.4

## 3.0.3

### Patch Changes

- 3d53d4c08: Fix an issue where a missing tsconfig.json file would throw an error on dev/deploy
- 3d53d4c08: Fixes for CLI update command, and make the hide the "whoami" command output when running in dev.
- Updated dependencies [3d53d4c08]
- Updated dependencies [3d53d4c08]
  - @trigger.dev/core@3.0.3
  - @trigger.dev/build@3.0.3

## 3.0.2

### Patch Changes

- 2b5771f38: Remove duplicate bin definition, fixes issue #1311
- de135e488: Configurable deployed heartbeat interval via HEARTBEAT_INTERVAL_MS env var
  - @trigger.dev/build@3.0.2
  - @trigger.dev/core@3.0.2

## 3.0.1

### Patch Changes

- 3aa581179: Fixing false-positive package version mismatches
- Updated dependencies [3aa581179]
  - @trigger.dev/build@3.0.1
  - @trigger.dev/core@3.0.1

## 3.0.0

### Major Changes

- cf13fbdf3: Release 3.0.0
- 395abe1b9: Updates to support Trigger.dev v3

### Patch Changes

- b8477ea2b: Fixes an issue with scoped packages in additionalPackages option
- ed2a26c86: - Fix additionalFiles that aren't decendants
  - Stop swallowing uncaught exceptions in prod
  - Improve warnings and errors, fail early on critical warnings
  - New arg to --save-logs even for successful builds
- 9971de6a1: Increase span attribute value length limit to 2048
- d4ccdf710: Add an e2e suite to test compiling with v3 CLI.
- b20760173: v3 CLI update command and package manager detection fix
- 43bc7ed94: Hoist uncaughtException handler to the top of workers to better report error messages
- c702d6a9c: better handle task metadata parse errors, and display nicely formatted errors
- c11a77f50: cli v3: increase otel force flush timeout to 30s from 500ms
- 5b745dc1a: Vastly improved dev command output
- b66d5525e: add machine config and secure zod connection
- 9491a1649: Implement task.onSuccess/onFailure and config.onSuccess/onFailure
- 1670c4c41: Remove "log" Log Level, unify log and info messages under the "info" log level
- 5a6e79e0c: Fixing missing logs when importing client @opentelemetry/api
- b271742dc: Configurable log levels in the config file and via env var
- 279717b09: Don’t swallow some error messages when deploying
- dbda820a7: - Prevent uncaught exceptions when handling WebSocket messages
  - Improve CLI dev command WebSocket debug and error logging
- 8578c9b28: Fixed empty env vars overriding in dev runs
- 4986bfda2: Add option to print console logs in the dev CLI locally (issue #1014)
- e667028d4: Strip out server-only package from worker builds
- b68012f81: Remove the env var check during deploy (too many false negatives)
- f9ec66c56: New Build System
- f96f1e91a: Better handle issues with resolving dependency versions during deploy
- 374b6b9c0: Increase dev worker timeout
- 624ddce32: Fix permissions inside node_modules
- c2707800a: Improve prisma errors for missing postinstall
- 3a1b0c486: v3: Environment variable management API and SDK, along with resolveEnvVars CLI hook
- c75e29a9a: Add sox and audiowaveform binaries to worker images
- d6c6dc993: try/catch opening the login URL
- c1d4c04e8: Fix automatic opening of login URL on linux-server systems with missing xdg-open
- a86f36cef: Fix TypeScript inclusion in tsconfig.json for `cli-v3 init`
- 1b90ffbb8: v3: Usage tracking
- 5cf90da72: Fix issues that could result in unreezable state run crashes. Details:
  - Never checkpoint between attempts
  - Some messages and socket data now include attempt numbers
  - Remove attempt completion replays
  - Additional prod entry point logging
  - Fail runs that receive deprecated (pre-lazy attempt) execute messages
- 7ea8532cc: Display errors for runs and deployments
- 63a643b7c: v3: fix digest extraction
- d9c9e80bc: Changed "Worker" to "Version" in the dev command key
- 1207efbba: Correctly handle self-hosted deploy command errors
- 83dc87155: Fix issues with consecutive waits
- 2156e1526: Adding some additional telemetry during deploy to help debug issues
- 16ad59533: v3: update @depot/cli to latest 0.0.1-cli.2.71.0
- e35f29764: Default to retrying enabled in dev when running init
- ae9a8b0ce: Automatically bundle internal packages that use file, link or workspace protocl
- e3cf456c6: Handle string and non-stringifiable outputs like functions
- f04041744: Fix entry point paths on windows
- 8c4df326c: Improve error messages during dev/deploy and handle deploy image build issues
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

- 8578c9b28: Support self-hosters pushing to a custom registry when running deploy
- b68012f81: Fixes an issue that was treating v2 trigger directories as v3
- e417aca87: Added config option extraCACerts to ProjectConfig type. This copies the ca file along with additionalFiles and sets NODE_EXTRA_CA_CERTS environment variable in built image as well as running the task.
- 568da0178: - Improve non-zero exit code error messages
  - Detect OOM conditions within worker child processes
  - Internal errors can have optional stack traces
  - Docker provider can be set to enforce machine presets
- 0e919f56f: Better handle uncaught exceptions
- cf13fbdf3: Add --runtime option to the init CLI command
- b271742dc: Added a Node.js runtime check for the CLI
- cf13fbdf3: trigger.dev init now adds @trigger.dev/build to devDependencies
- 01633c9c0: Output stderr logs on dev worker failure
- f2894c177: Fix post start hooks
- 52b6f48a9: Add e2e fixtures corresponding to past issues
  Implement e2e suite parallelism
  Enhance log level for specific e2e suite messages
- de1cc868e: Fix dev CLI output when not printing update messages
- 328947dbf: Use the dashboard url instead of the API url for the View logs link
- ebeb79052: Add typescript as a dependency so the esbuild-decorator will work even when running in npx
- 5ae3da6b4: Await file watcher cleanup in dev
- e337b2165: Add a postInstall option to allow running scripts after dependencies have been installed in deployed images
- 1c24348f7: Add openssl to prod worker image and allow passing auth token via env var for deploy
- 719c0a0b9: Fixed incorrect span timings around checkpoints by implementing a precise wall clock that resets after restores
- 74d1e61e4: Fix a bug where revoking the CLI token would prevent you from ever logging in again with the CLI.
- 52b2a8289: Add git to prod worker image which fixes private package installs
- 4986bfda2: Adding task with a triggerSource of schedule
- 8578c9b28: Fix --project-ref when running deploy
- 68d32429b: Capture and display stderr on index failures
- e9a63a486: Lock SDK and CLI deps on exact core version
- 8757fdcee: v3: [prod] force flush timeout should be 1s
- 26093896d: When using idempotency keys, triggerAndWait and batchTriggerAndWait will still work even if the existing runs have already been completed (or even partially completed, in the case of batchTriggerAndWait)

  - TaskRunExecutionResult.id is now the run friendlyId, not the attempt friendlyId
  - A single TaskRun can now have many batchItems, in the case of batchTriggerAndWait while using idempotency keys
  - A run’s idempotencyKey is now added to the ctx as well as the TaskEvent and displayed in the span view
  - When resolving batchTriggerAndWait, the runtimes no longer reject promises, leading to an error in the parent task

- 49184c718: Update trigger.dev CLI for new batch otel support
- b82db67b8: Add additional logging around cleaning up dev workers, and always kill them after 5 seconds if they haven't already exited
- f56582995: v3: Copy over more of the project's package.json keys into the deployed package.json (support for custom config like zenstack)
- d3a18fbdf: Fix package builds and CLI commands on Windows
- 77ad4127c: Improved ESM module require error detection logic
- 98ef17029: Set the deploy timeout to 3mins from 1min
- b68012f81: Move to our global system from AsyncLocalStorage for the current task context storage
- 098932ea9: v3: vercel edge runtime support
- f04041744: Support custom config file names & paths
- 8694e573f: Fix CLI logout and add list-profiles command
- 9835f4ec5: v3: fix otel flushing causing CLEANUP ack timeout errors by always setting a forceFlushTimeoutMillis value
- d0d3a64bd: - Prevent downgrades during update check and advise to upgrade CLI
  - Detect bun and use npm instead
  - During init, fail early and advise if not a TypeScript project
  - During init, allow specifying custom package manager args
  - Add links to dev worker started message
  - Fix links in unsupported terminals
- 6dcfeadac: Fixing an issue with bundling @trigger.dev/core/v3 in dev when using pnpm
- 35dbaedf6: - Fix init command SDK pinning
  - Show --api-url / -a flag where needed
  - CLI now also respects `TRIGGER_TELEMETRY_DISABLED`
  - Dedicated docker checkpoint test function
- a50063ce0: Always insert the dirs option when initializing a new project in the trigger.config.ts
- 9bcb8cb42: Added DEBUG to the ignored env vars
- e02320f65: fix: allow command login to read api url from cli args
- 8578c9b28: Fixed stuck runs when a child run fails with a process exit
- f1571cbfa: Fixed an issue where the trigger.dev package was not being built before publishing to npm
- f93eae300: Dynamically import superjson and fix some bundling issues
- 5ae3da6b4: - Fix artifact detection logs
  - Fix OOM detection and error messages
  - Add test link to cli deployment completion
- 75ec4ac6a: v3: postInstall config option now replaces the postinstall script found in package.json
- 9be1557bb: Changed the binary name from trigger.dev to triggerdev to fix a Windows issue
- c37c82231: Use locked package versions when resolving dependencies in deployed workers
- 7a9bd18ba: Stop swallowing deployment errors and display them better
- 6406924b0: Ensure @trigger.dev/sdk and @trigger.dev/core are always in the list of deployed dependencies
- 598906fc4: Fix for typo in v3 CLI login command
- d3a18fbdf: Init command was failing on Windows because of bad template paths
- 62c9a5b71: Fixes an issue that caused failed tasks when resuming after calling `triggerAndWait` or `batchTriggerAndWait` in prod/staging (this doesn't effect dev).

  The version of Node.js we use for deployed workers (latest 20) would crash with an out-of-memory error when the checkpoint was restored. This crash does not happen on Node 18x or Node21x, so we've decided to upgrade the worker version to Node.js21x, to mitigate this issue.

  You'll need to re-deploy to production to fix the issue.

- 392453e8a: Fix for when a log flush times out and the process is checkpointed
- 8578c9b28: Add remote forced externals system, in case we come across another package that cannot be bundled (spurred on by header-generator)
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
- b68012f81: Add support for tasks located in subdirectories inside trigger dirs
- c7a55804d: Fix jsonc-parser import
- c092c0f9d: v3: Prevent legacy-peer-deps=true from breaking deploys

  When a global `.npmrc` file includes `legacy-peer-deps=true`, deploys would fail on the `npm ci` step because the package-lock.json wouldn't match the `package.json` file. This is because inside the image build, the `.npmrc` file would not be picked up and so `legacy-peer-deps` would end up being false (which is the default). This change forces the `package-lock.json` file to be created using `legacy-peer-deps=false`

- 8578c9b28: Only import import-in-the-middle hook if there are instrumented packages
- f04041744: Support for custom conditions
- 6e65591e8: Fix various e2e issues for 'resolve-legacy-peer-deps' fixture, installation of fixture deps and lockfile-based test skipping'
- 8e5ef176a: Increase cleanup IPC timeout
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
- Updated dependencies [8c690a960]
- Updated dependencies [8578c9b28]
- Updated dependencies [203e00208]
- Updated dependencies [b4f9b70ae]
- Updated dependencies [1b90ffbb8]
- Updated dependencies [5cf90da72]
- Updated dependencies [cf13fbdf3]
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
- Updated dependencies [8578c9b28]
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
- Updated dependencies [cf13fbdf3]
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
- Updated dependencies [f9ec66c56]
- Updated dependencies [e69ffd314]
- Updated dependencies [8578c9b28]
- Updated dependencies [f04041744]
- Updated dependencies [d934feb02]
  - @trigger.dev/core@3.0.0
  - @trigger.dev/build@3.0.0

## 3.0.0-beta.55

### Patch Changes

- @trigger.dev/core@3.0.0-beta.55

## 3.0.0-beta.54

### Patch Changes

- @trigger.dev/core@3.0.0-beta.54

## 3.0.0-beta.53

### Patch Changes

- 5cf90da72: Fix issues that could result in unreezable state run crashes. Details:
  - Never checkpoint between attempts
  - Some messages and socket data now include attempt numbers
  - Remove attempt completion replays
  - Additional prod entry point logging
  - Fail runs that receive deprecated (pre-lazy attempt) execute messages
- Updated dependencies [5cf90da72]
  - @trigger.dev/core@3.0.0-beta.53

## 3.0.0-beta.52

### Patch Changes

- c1d4c04e8: Fix automatic opening of login URL on linux-server systems with missing xdg-open
- Updated dependencies [9882d66f8]
- Updated dependencies [09413a62a]
  - @trigger.dev/core@3.0.0-beta.52

## 3.0.0-beta.51

### Patch Changes

- ae9a8b0ce: Automatically bundle internal packages that use file, link or workspace protocl
- 6e65591e8: Fix various e2e issues for 'resolve-legacy-peer-deps' fixture, installation of fixture deps and lockfile-based test skipping'
- Updated dependencies [55264657d]
  - @trigger.dev/core@3.0.0-beta.51

## 3.0.0-beta.50

### Patch Changes

- Updated dependencies [8ba998794]
  - @trigger.dev/core@3.0.0-beta.50

## 3.0.0-beta.49

### Patch Changes

- 9971de6a1: Increase span attribute value length limit to 2048
- dbda820a7: - Prevent uncaught exceptions when handling WebSocket messages
  - Improve CLI dev command WebSocket debug and error logging
- c2707800a: Improve prisma errors for missing postinstall
- d6c6dc993: try/catch opening the login URL
- e417aca87: Added config option extraCACerts to ProjectConfig type. This copies the ca file along with additionalFiles and sets NODE_EXTRA_CA_CERTS environment variable in built image as well as running the task.
- Updated dependencies [dbda820a7]
- Updated dependencies [e417aca87]
- Updated dependencies [d934feb02]
  - @trigger.dev/core@3.0.0-beta.49

## 3.0.0-beta.48

### Patch Changes

- @trigger.dev/core@3.0.0-beta.48

## 3.0.0-beta.47

### Patch Changes

- 16ad59533: v3: update @depot/cli to latest 0.0.1-cli.2.71.0
- Updated dependencies [4f95c9de4]
- Updated dependencies [e04d44866]
  - @trigger.dev/core@3.0.0-beta.47

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

- Updated dependencies [14c2bdf89]
  - @trigger.dev/core@3.0.0-beta.46

## 3.0.0-beta.45

### Patch Changes

- 374b6b9c0: Increase dev worker timeout
- c75e29a9a: Add sox and audiowaveform binaries to worker images
- 568da0178: - Improve non-zero exit code error messages
  - Detect OOM conditions within worker child processes
  - Internal errors can have optional stack traces
  - Docker provider can be set to enforce machine presets
- 52b6f48a9: Add e2e fixtures corresponding to past issues
  Implement e2e suite parallelism
  Enhance log level for specific e2e suite messages
- 5ae3da6b4: Await file watcher cleanup in dev
- f56582995: v3: Copy over more of the project's package.json keys into the deployed package.json (support for custom config like zenstack)
- d0d3a64bd: - Prevent downgrades during update check and advise to upgrade CLI
  - Detect bun and use npm instead
  - During init, fail early and advise if not a TypeScript project
  - During init, allow specifying custom package manager args
  - Add links to dev worker started message
  - Fix links in unsupported terminals
- 5ae3da6b4: - Fix artifact detection logs
  - Fix OOM detection and error messages
  - Add test link to cli deployment completion
- 75ec4ac6a: v3: postInstall config option now replaces the postinstall script found in package.json
- Updated dependencies [0e77e7ef7]
- Updated dependencies [568da0178]
- Updated dependencies [5ae3da6b4]
  - @trigger.dev/core@3.0.0-beta.45

## 3.0.0-beta.44

### Patch Changes

- Updated dependencies [39885a427]
  - @trigger.dev/core@3.0.0-beta.44

## 3.0.0-beta.43

### Patch Changes

- 77ad4127c: Improved ESM module require error detection logic
- Updated dependencies [34ca7667d]
  - @trigger.dev/core@3.0.0-beta.43

## 3.0.0-beta.42

### Patch Changes

- @trigger.dev/core@3.0.0-beta.42

## 3.0.0-beta.41

### Patch Changes

- c7a55804d: Fix jsonc-parser import
  - @trigger.dev/core@3.0.0-beta.41

## 3.0.0-beta.40

### Patch Changes

- 098932ea9: v3: vercel edge runtime support
- 9835f4ec5: v3: fix otel flushing causing CLEANUP ack timeout errors by always setting a forceFlushTimeoutMillis value
- Updated dependencies [55d1f8c67]
- Updated dependencies [098932ea9]
- Updated dependencies [9835f4ec5]
  - @trigger.dev/core@3.0.0-beta.40

## 3.0.0-beta.39

### Patch Changes

- 8757fdcee: v3: [prod] force flush timeout should be 1s
  - @trigger.dev/core@3.0.0-beta.39

## 3.0.0-beta.38

### Patch Changes

- d4ccdf710: Add an e2e suite to test compiling with v3 CLI.
- 1b90ffbb8: v3: Usage tracking
- e02320f65: fix: allow command login to read api url from cli args
- Updated dependencies [1b90ffbb8]
- Updated dependencies [0ed93a748]
- Updated dependencies [c405ae711]
- Updated dependencies [c405ae711]
  - @trigger.dev/core@3.0.0-beta.38

## 3.0.0-beta.37

### Patch Changes

- c11a77f50: cli v3: increase otel force flush timeout to 30s from 500ms
- 01633c9c0: Output stderr logs on dev worker failure
- 68d32429b: Capture and display stderr on index failures
- 35dbaedf6: - Fix init command SDK pinning
  - Show --api-url / -a flag where needed
  - CLI now also respects `TRIGGER_TELEMETRY_DISABLED`
  - Dedicated docker checkpoint test function
- Updated dependencies [68d32429b]
- Updated dependencies [68d32429b]
  - @trigger.dev/core@3.0.0-beta.37

## 3.0.0-beta.36

### Patch Changes

- 8e5ef176a: Increase cleanup IPC timeout
- Updated dependencies [b4f9b70ae]
- Updated dependencies [ba71f959e]
  - @trigger.dev/core@3.0.0-beta.36

## 3.0.0-beta.35

### Patch Changes

- 98ef17029: Set the deploy timeout to 3mins from 1min
- e69ffd314: - Clear paused states before retry
  - Detect and handle unrecoverable worker errors
  - Remove checkpoints after successful push
  - Permanently switch to DO hosted busybox image
  - Fix IPC timeout issue, or at least handle it more gracefully
  - Handle checkpoint failures
  - Basic chaos monkey for checkpoint testing
  - Stack traces are back in the dashboard
  - Display final errors on root span
- Updated dependencies [ece6ca678]
- Updated dependencies [e69ffd314]
- Updated dependencies [e69ffd314]
  - @trigger.dev/core@3.0.0-beta.35

## 3.0.0-beta.34

### Patch Changes

- 5a6e79e0c: Fixing missing logs when importing client @opentelemetry/api
- 3a1b0c486: v3: Environment variable management API and SDK, along with resolveEnvVars CLI hook
- a86f36cef: Fix TypeScript inclusion in tsconfig.json for `cli-v3 init`
- c092c0f9d: v3: Prevent legacy-peer-deps=true from breaking deploys

  When a global `.npmrc` file includes `legacy-peer-deps=true`, deploys would fail on the `npm ci` step because the package-lock.json wouldn't match the `package.json` file. This is because inside the image build, the `.npmrc` file would not be picked up and so `legacy-peer-deps` would end up being false (which is the default). This change forces the `package-lock.json` file to be created using `legacy-peer-deps=false`

- Updated dependencies [3a1b0c486]
- Updated dependencies [3f8b6d8fc]
- Updated dependencies [1281d40e4]
  - @trigger.dev/core@3.0.0-beta.34

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
