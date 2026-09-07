import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { apiClientManager, taskContext } from "@trigger.dev/core/v3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { update } from "./envvars.js";

type ReceivedRequest = {
  method: string;
  url: string;
  authorization?: string;
  body: unknown;
};

describe("envvars.update outside a task", () => {
  let server: Server;
  let baseUrl: string;
  let requests: ReceivedRequest[];

  beforeEach(async () => {
    requests = [];
    apiClientManager.disable();
    taskContext.disable();
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
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    apiClientManager.disable();
    taskContext.disable();
  });

  it("PUTs the 4-arg form to /projects/{ref}/envvars/{slug}/{name}", async () => {
    const key = "tr_dev_sk_0123456789abcdefghijklmn";
    await apiClientManager.runWithConfig({ baseURL: baseUrl, accessToken: key }, () =>
      update("proj_x", "dev", "FOO", { value: "bar" })
    );

    expect(requests).toEqual([
      {
        method: "PUT",
        url: "/api/v1/projects/proj_x/envvars/dev/FOO",
        authorization: `Bearer ${key}`,
        body: { value: "bar" },
      },
    ]);
  });

  it("throws name is required when the 4-arg name is missing", () => {
    expect(() => update("proj_x", "dev", undefined as unknown as string, { value: "bar" })).toThrow(
      "name is required"
    );
    expect(requests).toEqual([]);
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

  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ success: true }));
}
