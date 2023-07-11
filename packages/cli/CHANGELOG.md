# create-trigger

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
