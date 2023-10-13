# internal-platform

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
