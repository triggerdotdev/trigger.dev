import { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PrismaClient } from "@trigger.dev/database";
import { createRedisContainer, createPostgresContainer } from "./test/utils";
import { StartedRedisContainer } from "@testcontainers/redis";
import { Redis, RedisOptions } from "ioredis";

let postgresContainer: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;

describe("Placeholder", () => {
  beforeEach(async () => {
    const pg = await createPostgresContainer();
    postgresContainer = pg.container;
    const rd = await createRedisContainer();
    redisContainer = rd.container;
  }, 30_000);

  afterEach(async () => {
    await postgresContainer?.stop();
    await redisContainer?.stop();
  }, 10_000);

  it("Simple connection test", async () => {
    const prisma = new PrismaClient({
      datasources: {
        db: {
          url: postgresContainer.getConnectionUri(),
        },
      },
    });

    await prisma.user.create({
      data: {
        authenticationMethod: "MAGIC_LINK",
        email: "test@example.com",
      },
    });

    const result = await prisma.user.findMany();
    expect(result.length).toEqual(1);
    expect(result[0].email).toEqual("test@example.com");

    const redis = new Redis({
      host: redisContainer.getHost(),
      port: redisContainer.getPort(),
      password: redisContainer.getPassword(),
    });
    await redis.set("mykey", "value");
    const value = await redis.get("mykey");
    expect(value).toEqual("value");

    await redis.quit();
  });
});
