import { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PrismaClient } from "@trigger.dev/database";
import { createTestRedisClient, createTestPrismaClient } from "./test/utils";
import { StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";

let postgresContainer: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let redisContainer: StartedRedisContainer;
let redis: Redis;

describe("Placeholder", () => {
  beforeEach(async () => {
    const pg = await createTestPrismaClient();
    postgresContainer = pg.container;
    prisma = pg.prisma;
    const rd = await createTestRedisClient();
    redisContainer = rd.container;
    redis = rd.client;
  }, 30_000);

  afterEach(async () => {
    await prisma?.$disconnect();
    await postgresContainer?.stop();
    await redis?.quit();
    await redisContainer?.stop();
  }, 10_000);

  it("Simple connection test", async () => {
    await prisma.user.create({
      data: {
        authenticationMethod: "MAGIC_LINK",
        email: "test@example.com",
      },
    });

    const result = await prisma.user.findMany();
    expect(result.length).toEqual(1);
    expect(result[0].email).toEqual("test@example.com");

    await redis.set("mykey", "value");
    const value = await redis.get("mykey");
    expect(value).toEqual("value");
  });
});
