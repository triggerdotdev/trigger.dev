# create-trigger

## 2.1.4

### Patch Changes

- 486ed20a: Moved examples to references in the monorepo
- 1a495272: CLI now supports multiple frameworks (starting with Next.js and Remix)

## 2.1.3

## 2.1.2

## 2.1.1

### Patch Changes

- feat: add proxy support for node-fetch ([#404](https://github.com/triggerdotdev/trigger.dev/pull/404))
- If Nextjs project detection fails, point people at the installation docs ([#446](https://github.com/triggerdotdev/trigger.dev/pull/446))
- create-integration uses updated OpenAI prompts ([`39b8445e`](https://github.com/triggerdotdev/trigger.dev/commit/39b8445e06cc389fc5d24efc2ac23ed9644f2733))

## 2.1.0

### Minor Changes

- Integrations are now simpler and support authentication during webhook registration ([`878da3c0`](https://github.com/triggerdotdev/trigger.dev/commit/878da3c01f0a4dfaf33a1f8943a7ad4eed8b8877))

## 2.1.0-beta.1

## 2.1.0-beta.0

### Minor Changes

- Integrations are now simpler and support authentication during webhook registration ([`878da3c0`](https://github.com/triggerdotdev/trigger.dev/commit/878da3c01f0a4dfaf33a1f8943a7ad4eed8b8877))

## 2.0.14

## 2.0.13

### Patch Changes

- provided a fix to the CLI dev command tunnel not working if you are already running ngrok ([#407](https://github.com/triggerdotdev/trigger.dev/pull/407))
- fix: init will no longer fail when outside of a git repo ([`3028b6ad`](https://github.com/triggerdotdev/trigger.dev/commit/3028b6ad9d693d2f1662c4338d44ac9d3bf0da3a))
- feat: Checks for outdated packages when running the dev command with instructions on how to update ([#412](https://github.com/triggerdotdev/trigger.dev/pull/412))

## 2.0.12

## 2.0.11

### Patch Changes

- 3ce53970: Added the send-event command
- 3897e6e6: Make it more clear which API key the init command expects
- b5db9f5e: Adding MIT license
- dd107176: Added hostname option to the cli dev command
- 8cf85443: Bugfix: @trigger.dev/cli init now correctly identifies the App Dir when using JS
- 4e78da31: fix: Add an update sub-command the @trigger.dev/cli that updates all @trigger.dev/\* packages
- 135cb492: fixed the cli init log message to show the correct path to the app route created

## 2.0.10

### Patch Changes

- 4ca9f182: Added tests to the CLI, updated tsconfig file accordingly
- 591422b8: Added whoami command, fixed TypeScript error
- a69f756e: Updated example job for the pages router

## 2.0.9

### Patch Changes

- b62df731: Fixed the example Job trigger file import path when using Pages Router with no path alias

## 2.0.8

### Patch Changes

- c246578a: Made the CLI error more helpful if you’re not running your Next.js app
- d395b957: fix: Handle ngrok config upgrade error in createTunnel function

## 2.0.7

### Patch Changes

- a1bc15d1: Updated the example job
- 3ce6dece: creates a job catalog file when a new integration is created with the create-integration command
- a90908df: CLI init fixes: don't ask for endpoint slug, fix for next.config and package manager artifact issue

## 2.0.6

## 2.0.5

## 2.0.4

### Patch Changes

- ff04bf44: Detect package manager from artifacts if they exist
- d5b8f829: The cli init command creates a jobs/index file and that is used to import jobs
- e7402978: Detect Next.js project by looking at dependencies if can't find next.config.js

## 2.0.3

### Patch Changes

- fc78854e: Don't require the TRIGGER_API_URL to be set (it has a default)
- 81180999: The dev command should use a POST request when doing the PING to the local server

## 2.0.2

### Patch Changes

- ee99191f: Sync all package versions

## 0.2.1

### Patch Changes

- 5fbd7226: Added retrying and better messaging
- efd59097: Detect if a nextjs project is running on the specified port before opening tunnel
- 454ad25b: Changed the text on the ID question
- e2ce9472: A number of improvements to the initialization experience:

  - Detect middleware usage and warn about how it could conflict with Trigger.dev and with a link to the docs
  - Lookup package versions and use the latest versions
  - Better error messages when registering an endpoint doesn't work

- 6f19a3e7: Fix for Next.js projects using the src dir
- 28914b87: Creating the init CLI package
- d7c4b242: replace tsconfig package with tsconfck package
- 85108cfc: Remove the localhost default for endpoint URL
- b39f1694: Fixed the version of the @trigger.dev/nextjs package
- b2a8b565: Split the CLI into two commands, init and a new dev command
- f01af9c0: Upgrade to zod 3.21.4
- 6d4922f4: api.trigger.dev is now the default cloud url
- 1bf2802b: Parse .env file using dotenv instead of hand-parsing it
- 6c869466: [dev] Better handle errors when registering endpoint
- 2e162423: Improved the CLI prompts
- c2e2f7ca: Removed --tunnel option, currently we just support ngrok
- 5e36ad96: Generate the README for a new integration package
- 2f1b2a32: This is a patch bump
- 520ab88a: Adding the create-integration command to scaffold out new integration packages (inside or outside of the monorepo)
- 0013e78b: Export the client from the generated code and added code comments
- 2c0ea0c1: Set Node version to 16.8 and above
- d0ad2bd3: Fixed the help defaults
- f4db1b27: Initializing a next.js project now creates a better file structure
- d0b19d50: Add option to specify the path to the handler function in the dev command
- 568786e4: Fix when setting the url as an option
- facae926: Added basic telemetry
- 706ab20c: Add cli init support for nextjs projects using javascript
- 27a98121: allow trigger CLI init command to use endpointId if it is present in package.json
- 161d59d0: Added better Next Steps in the init cli command
- 94ae9e65: Fixed an issue that cause environment variables to be incorrectly added to .env.local
- 62f94206: Fixed CLI showing undefined when not specifying a trigger-url flag
- 01c0f9b3: Allow the CLI dev command to work outside of a Next.js project
- ac371664: Better handle input for the --trigger-url option
- b8b84d8d: Improved the endpoint prompt
- 37635774: Improved spinner and made port clear in logs

## 0.2.1-next.25

### Patch Changes

- 454ad25b: Changed the text on the ID question
- d7c4b242: replace tsconfig package with tsconfck package
- 706ab20c: Add cli init support for nextjs projects using javascript
- 27a98121: allow trigger CLI init command to use endpointId if it is present in package.json

## 0.2.1-next.24

### Patch Changes

- 2f1b2a32: This is a patch bump

## 0.2.1-next.23

### Patch Changes

- d0b19d50: Add option to specify the path to the handler function in the dev command

## 0.2.1-next.22

### Patch Changes

- 1bf2802b: Parse .env file using dotenv instead of hand-parsing it

## 0.2.1-next.21

### Patch Changes

- 01c0f9b3: Allow the CLI dev command to work outside of a Next.js project

## 0.2.1-next.20

### Patch Changes

- 5e36ad96: Generate the README for a new integration package
- 520ab88a: Adding the create-integration command to scaffold out new integration packages (inside or outside of the monorepo)

## 0.2.1-next.19

### Patch Changes

- 2c0ea0c1: Set Node version to 16.8 and above

## 0.2.1-next.18

### Patch Changes

- b8b84d8d: Improved the endpoint prompt

## 0.2.1-next.17

### Patch Changes

- 37635774: Improved spinner and made port clear in logs

## 0.2.1-next.16

### Patch Changes

- 568786e4: Fix when setting the url as an option

## 0.2.1-next.15

### Patch Changes

- f01af9c0: Upgrade to zod 3.21.4

## 0.2.1-next.14

### Patch Changes

- 6d4922f4: api.trigger.dev is now the default cloud url
- f4db1b27: Initializing a next.js project now creates a better file structure

## 0.2.1-next.13

### Patch Changes

- 6c869466: [dev] Better handle errors when registering endpoint
- 0013e78b: Export the client from the generated code and added code comments

## 0.2.1-next.12

### Patch Changes

- 5fbd7226: Added retrying and better messaging

## 0.2.1-next.11

### Patch Changes

- 161d59d0: Added better Next Steps in the init cli command

## 0.2.1-next.10

### Patch Changes

- c2e2f7ca: Removed --tunnel option, currently we just support ngrok

## 0.2.1-next.9

### Patch Changes

- b2a8b565: Split the CLI into two commands, init and a new dev command
- ac371664: Better handle input for the --trigger-url option

## 0.2.1-next.8

### Patch Changes

- e2ce9472: A number of improvements to the initialization experience:

  - Detect middleware usage and warn about how it could conflict with Trigger.dev and with a link to the docs
  - Lookup package versions and use the latest versions
  - Better error messages when registering an endpoint doesn't work

## 0.2.1-next.7

### Patch Changes

- 85108cfc: Remove the localhost default for endpoint URL

## 0.2.1-next.6

### Patch Changes

- 94ae9e65: Fixed an issue that cause environment variables to be incorrectly added to .env.local

## 0.2.1-next.5

### Patch Changes

- 62f94206: Fixed CLI showing undefined when not specifying a trigger-url flag

## 0.2.1-next.4

### Patch Changes

- Fixed the version of the @trigger.dev/nextjs package

## 0.2.1-next.3

### Patch Changes

- Improved the CLI prompts

## 0.2.1-next.2

### Patch Changes

- Fixed the help defaults

## 0.2.1-next.1

### Patch Changes

- 6f19a3e7: Fix for Next.js projects using the src dir

## 0.2.1-next.0

### Patch Changes

- 28914b87: Creating the init CLI package

## 0.2.0

### Minor Changes

- 26e69cb6: Easily scaffold out standalone trigger.dev projects using create-trigger and our templates

## 0.2.0-next.0

### Minor Changes

- 26e69cb6: Easily scaffold out standalone trigger.dev projects using create-trigger and our templates
