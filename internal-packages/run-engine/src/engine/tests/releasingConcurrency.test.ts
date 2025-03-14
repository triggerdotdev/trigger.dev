import { containerTest } from "@internal/testcontainers";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine Releasing Concurrency", () => {
  containerTest(
    "blocking a run with a waitpoint with releasing concurrency",
    async ({ prisma, redisOptions }) => {}
  );
});
