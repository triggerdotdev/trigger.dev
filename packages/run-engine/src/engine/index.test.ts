import { expect } from "vitest";
import { postgresTest, redisTest } from "../test/containerTest";

postgresTest("Prisma create user", { timeout: 15_000 }, async ({ prisma }) => {
  await prisma.user.create({
    data: {
      authenticationMethod: "MAGIC_LINK",
      email: "test@example.com",
    },
  });

  const result = await prisma.user.findMany();
  expect(result.length).toEqual(1);
  expect(result[0].email).toEqual("test@example.com");
});

redisTest("Set/get values", async ({ redis }) => {
  await redis.set("mykey", "value");
  const value = await redis.get("mykey");
  expect(value).toEqual("value");
});
