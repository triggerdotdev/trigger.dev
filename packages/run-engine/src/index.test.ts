import { expect } from "vitest";
import { z } from "zod";
import { SimpleQueue } from "./simpleQueue";
import { containerTest } from "./test/containerTest";

// Use the extended test
containerTest("Simple connection test", async ({ prisma, redis }) => {
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

containerTest("SimpleQueue", async ({ redisContainer }) => {
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

  const third = await queue.dequeue();
  expect(third).toEqual({ id: "3", item: { value: 3 } });

  await new Promise((resolve) => setTimeout(resolve, 100));

  const second = await queue.dequeue();
  expect(second).toEqual({ id: "2", item: { value: 2 } });

  const fourth = await queue.dequeue();
  expect(fourth).toBeNull();

  await queue.close();
});
