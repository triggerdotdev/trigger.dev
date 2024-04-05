# trigger.dev

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
