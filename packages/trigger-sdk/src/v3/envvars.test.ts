import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { apiClientManager } from "@trigger.dev/core/v3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as envvars from "./envvars.js";

type ReceivedRequest = {
  method: string;
  url: string;
};

describe("envvars.update outside a task context (GH #4264)", () => {
  let server: Server;
  let baseUrl: string;
  let requests: ReceivedRequest[];

  beforeEach(async () => {
    requests = [];
    server = createServer((request, response) => {
      requests.push({ method: request.method ?? "", url: request.url ?? "" });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("resolves the name argument instead of throwing ReferenceError", async () => {
    const key = "tr_prod_0123456789abcdefghijklmn";

    // Outside a task context, taskContext.ctx is undefined. Before the fix this
    // path evaluated `$name = name!`, but the implementation signature has no
    // `name` parameter, so it threw `ReferenceError: name is not defined`.
    await apiClientManager.runWithConfig({ baseURL: baseUrl, accessToken: key }, async () => {
      try {
        await envvars.update("proj_ref", "prod", "MY_SECRET", { value: "abc" });
      } catch (err) {
        // Response-shape concerns are irrelevant here; only assert the
        // argument-resolution crash is gone.
        expect((err as Error).message).not.toContain("name is not defined");
      }
    });

    const updateRequest = requests.find((request) => request.url.includes("MY_SECRET"));
    expect(updateRequest).toBeDefined();
    expect(updateRequest!.url).toContain("/projects/proj_ref/envvars/prod/MY_SECRET");
  });

  it("throws a clear error when the name is missing", async () => {
    const key = "tr_prod_0123456789abcdefghijklmn";

    await apiClientManager.runWithConfig({ baseURL: baseUrl, accessToken: key }, async () => {
      await expect(
        // @ts-expect-error deliberately omitting the name argument
        envvars.update("proj_ref", "prod", { value: "abc" })
      ).rejects.toThrow("name is required");
    });
  });
});
