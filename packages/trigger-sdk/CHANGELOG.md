# @trigger.dev/sdk

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

- 0b17912: Updated dependency to @trigger.dev/internal@0.1.0

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
