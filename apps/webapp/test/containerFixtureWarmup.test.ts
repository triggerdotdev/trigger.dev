import { containerTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 10_000 });

describe("container fixture warmup", () => {
  containerTest("the first test is not billed for the container boot", async ({ prisma }) => {
    const rows = await prisma.$queryRawUnsafe<Array<{ ok: number }>>("SELECT 1 as ok");

    expect(rows[0]?.ok).toBe(1);
  });

  containerTest("later tests still get a working fixture", async ({ prisma }) => {
    const rows = await prisma.$queryRawUnsafe<Array<{ ok: number }>>("SELECT 2 as ok");

    expect(rows[0]?.ok).toBe(2);
  });
});
