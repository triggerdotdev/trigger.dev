import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { z as z3 } from "zod/v3";
import { z as z4 } from "zod/v4";
import { zodfetchCursorPage, zodfetchOffsetLimitPage } from "./core.js";

describe("Zod pagination compatibility", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");

      if (request.url?.startsWith("/cursor")) {
        response.end(
          JSON.stringify({
            data: [{ value: "42" }],
            pagination: {},
          })
        );
        return;
      }

      response.end(
        JSON.stringify({
          data: [{ value: "42" }],
          pagination: { currentPage: "1", totalPages: "1", count: "1" },
        })
      );
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each([
    ["Zod 3", z3.object({ value: z3.coerce.number() })],
    ["Zod 4", z4.object({ value: z4.coerce.number() })],
  ])("parses cursor pages with %s caller schemas", async (_name, schema) => {
    const page = await zodfetchCursorPage(schema, `${baseUrl}/cursor`, {});

    expect(page.data).toEqual([{ value: 42 }]);
  });

  it.each([
    ["Zod 3", z3.object({ value: z3.coerce.number() })],
    ["Zod 4", z4.object({ value: z4.coerce.number() })],
  ])("parses offset pages with %s caller schemas", async (_name, schema) => {
    const page = await zodfetchOffsetLimitPage(schema, `${baseUrl}/offset`, {});

    expect(page.data).toEqual([{ value: 42 }]);
    expect(page.pagination).toEqual({ currentPage: 1, totalPages: 1, count: 1 });
  });
});
