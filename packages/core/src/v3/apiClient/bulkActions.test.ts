import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ApiClient } from "./index.js";

type ReceivedRequest = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
};

type RequestHandler = (request: ReceivedRequest, response: ServerResponse) => void | Promise<void>;

describe("ApiClient bulk actions", () => {
  let server: Server;
  let baseUrl: string;
  let receivedRequests: ReceivedRequest[] = [];
  let requestHandler: RequestHandler | undefined;

  beforeEach(async () => {
    receivedRequests = [];
    requestHandler = undefined;

    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", async () => {
        const received = {
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        } satisfies ReceivedRequest;
        receivedRequests.push(received);

        try {
          if (requestHandler) {
            await requestHandler(received, res);
          } else {
            json(res, { error: "No handler" }, 500);
          }
        } catch (error) {
          json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
        }
      });
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
  });

  it("posts the exact create bulk action request body", async () => {
    requestHandler = (_request, response) => json(response, { id: "bulk_created" });

    const client = new ApiClient(baseUrl, "tr_test_key");
    const result = await client.createBulkAction({
      action: "replay",
      filter: { status: ["FAILED"], taskIdentifier: "my-task" },
      name: "Replay failures",
      targetRegion: "eu_1",
    });

    expect(result).toEqual({ id: "bulk_created" });
    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0]?.method).toBe("POST");
    expect(receivedRequests[0]?.url).toBe("/api/v1/bulk-actions");
    expect(receivedRequests[0]?.headers.authorization).toBe("Bearer tr_test_key");
    expect(JSON.parse(receivedRequests[0]?.body ?? "{}")).toEqual({
      action: "replay",
      filter: { status: ["FAILED"], taskIdentifier: "my-task" },
      name: "Replay failures",
      targetRegion: "eu_1",
    });
  });

  it("lists bulk actions with cursor pagination params and parses dates", async () => {
    const createdAt = "2026-07-01T10:00:00.000Z";
    const completedAt = "2026-07-01T10:05:00.000Z";
    requestHandler = (_request, response) =>
      json(response, {
        data: [
          {
            id: "bulk_listed",
            name: "Cancel queued runs",
            type: "CANCEL",
            status: "COMPLETED",
            counts: { total: 3, success: 2, failure: 1 },
            createdAt,
            completedAt,
          },
        ],
        pagination: { next: "cursor_next", previous: "cursor_previous" },
      });

    const client = new ApiClient(baseUrl, "tr_test_key");
    const page = await client.listBulkActions({ limit: 2, after: "cursor_after" });

    expect(receivedRequests[0]?.method).toBe("GET");
    const url = new URL(receivedRequests[0]?.url ?? "", baseUrl);
    expect(url.pathname).toBe("/api/v1/bulk-actions");
    expect(url.searchParams.get("page[size]")).toBe("2");
    expect(url.searchParams.get("page[after]")).toBe("cursor_after");
    expect(page.pagination).toEqual({ next: "cursor_next", previous: "cursor_previous" });
    expect(page.data[0]?.createdAt).toEqual(new Date(createdAt));
    expect(page.data[0]?.completedAt).toEqual(new Date(completedAt));
  });

  it("auto-paginates bulk action lists", async () => {
    requestHandler = (request, response) => {
      const url = new URL(request.url, baseUrl);
      if (!url.searchParams.has("page[after]")) {
        return json(response, {
          data: [bulkActionObject("bulk_first")],
          pagination: { next: "cursor_next" },
        });
      }

      expect(url.searchParams.get("page[after]")).toBe("cursor_next");
      return json(response, {
        data: [bulkActionObject("bulk_second")],
        pagination: {},
      });
    };

    const client = new ApiClient(baseUrl, "tr_test_key");
    const ids: string[] = [];

    for await (const bulkAction of client.listBulkActions({ limit: 1 })) {
      ids.push(bulkAction.id);
    }

    expect(ids).toEqual(["bulk_first", "bulk_second"]);
    expect(receivedRequests).toHaveLength(2);
  });

  it("retrieves a bulk action by id", async () => {
    requestHandler = (_request, response) => json(response, bulkActionObject("bulk_retrieve"));

    const client = new ApiClient(baseUrl, "tr_test_key");
    const bulkAction = await client.retrieveBulkAction("bulk_retrieve");

    expect(receivedRequests[0]?.method).toBe("GET");
    expect(receivedRequests[0]?.url).toBe("/api/v1/bulk-actions/bulk_retrieve");
    expect(bulkAction.id).toBe("bulk_retrieve");
  });

  it("aborts a bulk action by id", async () => {
    requestHandler = (_request, response) => json(response, { id: "bulk_abort" });

    const client = new ApiClient(baseUrl, "tr_test_key");
    const result = await client.abortBulkAction("bulk_abort");

    expect(receivedRequests[0]?.method).toBe("POST");
    expect(receivedRequests[0]?.url).toBe("/api/v1/bulk-actions/bulk_abort/abort");
    expect(result).toEqual({ id: "bulk_abort" });
  });
});

function json(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function bulkActionObject(id: string) {
  return {
    id,
    type: "REPLAY",
    status: "PENDING",
    counts: { total: 1, success: 0, failure: 0 },
    createdAt: "2026-07-01T10:00:00.000Z",
  };
}
