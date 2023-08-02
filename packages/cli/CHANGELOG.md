# create-trigger

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
