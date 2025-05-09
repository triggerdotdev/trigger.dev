## Running Tests

We use vitest exclusively for testing. To execute tests for a particular workspace, run the following command:

```bash
pnpm run test --filter webapp
```

Prefer running tests on a single file (and first cding into the directory):

```bash
cd apps/webapp
pnpm run test ./src/components/Button.test.ts
```

If you are cd'ing into a directory, you may have to build dependencies first:

```bash
pnpm run build --filter webapp
cd apps/webapp
pnpm run test ./src/components/Button.test.ts
```

## Writing Tests

We use vitest for testing. We almost NEVER mock anything. Start with a top-level "describe", and have multiple "it" statements inside of it.

New test files should be placed right next to the file being tested. For example:

- Source file: `./src/services/MyService.ts`
- Test file: `./src/services/MyService.test.ts`

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

postgresTest:

```typescript
import { postgresTest } from "@internal/testcontainers";

describe("postgresTest", () => {
  postgresTest("should use postgres", async ({ prisma }) => {
    // prisma is an instance of PrismaClient
  });
});
```

containerTest:

```typescript
import { containerTest } from "@internal/testcontainers";

describe("containerTest", () => {
  containerTest("should use container", async ({ prisma, redisOptions }) => {
    // container has both prisma and redis
  });
});
```

## Dos and Dont's

- Do not mock anything.
- Do not use mocks in tests.
- Do not use spies in tests.
- Do not use stubs in tests.
- Do not use fakes in tests.
- Do not use sinon in tests.
- Structure each test with a setup, action, and assertion style.
- Feel free to write long test names.
- If there is any randomness in the code under test, use `seedrandom` to make it deterministic by allowing the caller to provide a seed.
