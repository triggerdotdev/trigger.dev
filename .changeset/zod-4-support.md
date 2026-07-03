---
"@trigger.dev/core": minor
"@trigger.dev/sdk": minor
"trigger.dev": minor
"@trigger.dev/redis-worker": minor
"@trigger.dev/schema-to-json": minor
---

Add zod v4 support. You can now use zod 3.25+ or zod 4 (the minimum zod 3 version is now 3.25.0). `zod` is now a peer dependency of `@trigger.dev/core`, `@trigger.dev/sdk`, `@trigger.dev/redis-worker`, and `@trigger.dev/schema-to-json`, so it shares a single copy with your project; if you depend on `@trigger.dev/core` directly, add `zod` to your own dependencies.

The published type declarations are built against zod 4. If you are still on zod 3, keep `skipLibCheck: true` in your tsconfig (the default in Trigger.dev's templates).
