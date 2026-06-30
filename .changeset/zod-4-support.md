---
"@trigger.dev/core": minor
"@trigger.dev/sdk": minor
"trigger.dev": minor
"@trigger.dev/redis-worker": minor
"@trigger.dev/schema-to-json": minor
---

Add zod v4 compatibility. The `zod` peer dependency is widened to `^3.25.0 || ^4.0.0`, so projects can use zod 3.25+ or zod 4. Internal code was updated for zod v4 API changes (`ZodError.errors` → `.issues`, single-arg `z.record` → keyed, unified `error` option, `z.ZodSchema`/`z.AnyZodObject` → `z.ZodType`/`z.ZodObject`, `z.any()` object fields made `.optional()` to preserve v3 inference). No runtime behavior change for existing zod 3 users.
