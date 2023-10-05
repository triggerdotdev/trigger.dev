# @trigger.dev/sdk

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
