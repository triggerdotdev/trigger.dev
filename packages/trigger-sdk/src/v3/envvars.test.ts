import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { apiClientManager, taskContext } from "@trigger.dev/core/v3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as envvars from "./envvars.js";

type ReceivedRequest = {
  method: string;
  url: string;
  authorization?: string;
  body: unknown;
};

describe("envvars.update", () => {
  let server: Server;
  let baseUrl: string;
  let requests: ReceivedRequest[];

  beforeEach(async () => {
    requests = [];
    server = createServer((request, response) => {
      void handleRequest(request, response, requests);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
    taskContext.disable();
  });

  afterEach(async () => {
    taskContext.disable();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe("outside task context", () => {
    it("updates an environment variable successfully with 4 arguments", async () => {
      const key = "tr_prod_sk_0123456789abcdefghijklmn";
      const result = await apiClientManager.runWithConfig(
        { baseURL: baseUrl, accessToken: key },
        () => envvars.update("proj_123", "prod", "MY_VAR", { value: "new_value" })
      );

      expect(result).toEqual({ success: true });
      expect(requests).toEqual([
        {
          method: "PUT",
          url: "/api/v1/projects/proj_123/envvars/prod/MY_VAR",
          authorization: `Bearer ${key}`,
          body: { value: "new_value" },
        },
      ]);
    });

    it("throws when slug is missing", () => {
      const key = "tr_prod_sk_0123456789abcdefghijklmn";
      expect(() =>
        apiClientManager.runWithConfig({ baseURL: baseUrl, accessToken: key }, () =>
          // @ts-expect-error test runtime validation
          envvars.update("MY_VAR", { value: "new_value" })
        )
      ).toThrow("slug is required");
    });

    it("throws when name is missing", () => {
      const key = "tr_prod_sk_0123456789abcdefghijklmn";
      expect(() =>
        apiClientManager.runWithConfig({ baseURL: baseUrl, accessToken: key }, () =>
          // @ts-expect-error test runtime validation
          envvars.update("proj_123", "prod", undefined, { value: "new_value" })
        )
      ).toThrow("name is required");
    });

    it("throws when params is missing", () => {
      const key = "tr_prod_sk_0123456789abcdefghijklmn";
      expect(() =>
        apiClientManager.runWithConfig({ baseURL: baseUrl, accessToken: key }, () =>
          // @ts-expect-error test runtime validation
          envvars.update("proj_123", "prod", "MY_VAR", undefined)
        )
      ).toThrow("params is required");
    });
  });

  describe("inside task context", () => {
    it("updates an environment variable with 2 arguments using context", async () => {
      const key = "tr_prod_sk_0123456789abcdefghijklmn";
      taskContext.setGlobalTaskContext({
        ctx: {
          project: { id: "proj_ctx_id", ref: "proj_ctx_ref", name: "ctx_proj" },
          environment: { id: "env_ctx_id", slug: "dev", name: "Development", type: "development" },
          organization: { id: "org_ctx_id", slug: "ctx_org", name: "Ctx Org" },
          run: { id: "run_ctx_id", isTest: false },
          task: { id: "task_ctx_id", filePath: "task.ts", exportName: "myTask" },
        },
      } as any);

      const result = await apiClientManager.runWithConfig(
        { baseURL: baseUrl, accessToken: key },
        () => envvars.update("CTX_VAR", { value: "ctx_val" })
      );

      expect(result).toEqual({ success: true });
      expect(requests).toEqual([
        {
          method: "PUT",
          url: "/api/v1/projects/proj_ctx_ref/envvars/dev/CTX_VAR",
          authorization: `Bearer ${key}`,
          body: { value: "ctx_val" },
        },
      ]);
    });

    it("updates an environment variable with explicit projectRef, slug, and name", async () => {
      const key = "tr_prod_sk_0123456789abcdefghijklmn";
      taskContext.setGlobalTaskContext({
        ctx: {
          project: { id: "proj_ctx_id", ref: "proj_ctx_ref", name: "ctx_proj" },
          environment: { id: "env_ctx_id", slug: "dev", name: "Development", type: "development" },
          organization: { id: "org_ctx_id", slug: "ctx_org", name: "Ctx Org" },
          run: { id: "run_ctx_id", isTest: false },
          task: { id: "task_ctx_id", filePath: "task.ts", exportName: "myTask" },
        },
      } as any);

      const result = await apiClientManager.runWithConfig(
        { baseURL: baseUrl, accessToken: key },
        () => envvars.update("other_proj", "staging", "OTHER_VAR", { value: "other_val" })
      );

      expect(result).toEqual({ success: true });
      expect(requests).toEqual([
        {
          method: "PUT",
          url: "/api/v1/projects/other_proj/envvars/staging/OTHER_VAR",
          authorization: `Bearer ${key}`,
          body: { value: "other_val" },
        },
      ]);
    });

    it("throws inside task context when 4-arg form is missing name", () => {
      const key = "tr_prod_sk_0123456789abcdefghijklmn";
      taskContext.setGlobalTaskContext({
        ctx: {
          project: { id: "proj_ctx_id", ref: "proj_ctx_ref", name: "ctx_proj" },
          environment: { id: "env_ctx_id", slug: "dev", name: "Development", type: "development" },
          organization: { id: "org_ctx_id", slug: "ctx_org", name: "Ctx Org" },
          run: { id: "run_ctx_id", isTest: false },
          task: { id: "task_ctx_id", filePath: "task.ts", exportName: "myTask" },
        },
      } as any);

      expect(() =>
        apiClientManager.runWithConfig({ baseURL: baseUrl, accessToken: key }, () =>
          // @ts-expect-error test runtime validation
          envvars.update("other_proj", "staging", undefined, { value: "other_val" })
        )
      ).toThrow("name is required");
    });

    it("throws inside task context when 4-arg form is missing params", () => {
      const key = "tr_prod_sk_0123456789abcdefghijklmn";
      taskContext.setGlobalTaskContext({
        ctx: {
          project: { id: "proj_ctx_id", ref: "proj_ctx_ref", name: "ctx_proj" },
          environment: { id: "env_ctx_id", slug: "dev", name: "Development", type: "development" },
          organization: { id: "org_ctx_id", slug: "ctx_org", name: "Ctx Org" },
          run: { id: "run_ctx_id", isTest: false },
          task: { id: "task_ctx_id", filePath: "task.ts", exportName: "myTask" },
        },
      } as any);

      expect(() =>
        apiClientManager.runWithConfig({ baseURL: baseUrl, accessToken: key }, () =>
          // @ts-expect-error test runtime validation
          envvars.update("other_proj", "staging", "OTHER_VAR", undefined)
        )
      ).toThrow("params is required");
    });
  });
});

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: ReceivedRequest[]
) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const rawBody = Buffer.concat(chunks).toString();
  requests.push({
    method: request.method ?? "",
    url: request.url ?? "",
    authorization: request.headers.authorization,
    body: rawBody ? JSON.parse(rawBody) : undefined,
  });

  if (request.method === "PUT" && request.url?.startsWith("/api/v1/projects/")) {
    return json(response, { success: true });
  }

  return json(response, { error: "Not found" }, 404);
}

function json(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
