---
"@trigger.dev/integration-kit": minor
"@trigger.dev/eslint-plugin": minor
"@trigger.dev/sdk": minor
"@trigger.dev/sveltekit": minor
"@trigger.dev/express": minor
"@trigger.dev/nestjs": minor
"@trigger.dev/nextjs": minor
"@trigger.dev/astro": minor
"@trigger.dev/core": minor
"@trigger.dev/cli": minor
---

Drop support for Node v16, require Node >= 18. This allows us to use native fetch in our SDK which paves the way for multi-platform support.
