import { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PrismaClient } from "@trigger.dev/database";
import { createRedisContainer, createPostgresContainer } from "./test/utils";
import { StartedRedisContainer } from "@testcontainers/redis";
import { Redis, RedisOptions } from "ioredis";
import SimpleQueue from "./simpleQueue";
import { z } from "zod";

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

  it("SimpleQueue", async () => {
    const queue = new SimpleQueue(
      "test",
      z.object({
        value: z.number(),
      }),
      {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      }
    );

    await queue.enqueue("1", { value: 1 });
    await queue.enqueue("2", { value: 2 }, new Date(Date.now() + 100));
    await queue.enqueue("3", { value: 3 });

    const first = await queue.dequeue();
    expect(first).toEqual({ id: "1", item: { value: 1 } });

    //we added the second one with a delay
    const third = await queue.dequeue();
    expect(third).toEqual({ id: "3", item: { value: 3 } });

    //wait for 100 ms
    await new Promise((resolve) => setTimeout(resolve, 100));

    const second = await queue.dequeue();
    expect(second).toEqual({ id: "2", item: { value: 2 } });

    const fourth = await queue.dequeue();
    expect(fourth).toBeNull();

    await queue.close();
  });
});
