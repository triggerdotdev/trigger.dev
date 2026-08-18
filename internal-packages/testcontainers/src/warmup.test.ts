import { describe, expect, vi } from "vitest";
import { clickhouseTest, containerTest } from "./index";

vi.setConfig({ testTimeout: 10_000 });

describe.skip("a skipped suite that touches the fixture first", () => {
  containerTest("never runs", async ({ prisma }) => {
    expect(prisma).toBeDefined();
  });
});

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

describe("worker-scoped fixtures are warmed too", () => {
  clickhouseTest("clickhouse is up before the first test", async ({ clickhouseClient }) => {
    const rs = await clickhouseClient.query({ query: "SELECT 1 AS ok", format: "JSONEachRow" });
    const rows = await rs.json<{ ok: number }>();

    expect(rows[0]?.ok).toBe(1);
  });
});
