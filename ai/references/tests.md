## Running Tests

We use vitest exclusively for testing. To execute tests for a particular workspace, run the following command:

```bash
pnpm test --filter webapp
```

Prefer running tests on a single file:

```bash
pnpm test --filter webapp/src/components/Button.test.ts
```

## Writing Tests

We use vitest for testing. We almost NEVER mock anything. Start with a top-level "describe", and have multiple "it" statements inside of it.

When writing anything that needs redis or postgresql, we have some internal "testcontainers" that are used to spin up a local instance, redis, or both.

redisTest:

```typescript
import { redisTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";

describe("redisTest", () => {
  redisTest("should use redis", async ({ redisOptions }) => {
    const redis = createRedisClient(redisOptions);

    await redis.set("test", "test");
    const result = await redis.get("test");
    expect(result).toEqual("test");
  });
});
```
