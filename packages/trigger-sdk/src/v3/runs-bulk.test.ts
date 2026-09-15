import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { apiClientManager } from "@trigger.dev/core/v3";
import { runs } from "./runs.js";

type ReceivedRequest = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
};

type RequestHandler = (request: ReceivedRequest, response: ServerResponse) => void | Promise<void>;

describe("runs.bulk", () => {
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
    apiClientManager.disable();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("creates a cancel bulk action", async () => {
    requestHandler = (_request, response) => json(response, { id: "bulk_cancel" });

    const result = await withApiClient(() =>
      runs.bulk.cancel({ runIds: ["run_1", "run_2"], name: "Cancel selected" })
    );

    expect(result).toEqual({ id: "bulk_cancel" });
    expect(receivedRequests[0]?.method).toBe("POST");
    expect(receivedRequests[0]?.url).toBe("/api/v1/bulk-actions");
    expect(JSON.parse(receivedRequests[0]?.body ?? "{}")).toEqual({
      action: "cancel",
      runIds: ["run_1", "run_2"],
      name: "Cancel selected",
    });
  });

  it("creates a replay bulk action", async () => {
    requestHandler = (_request, response) => json(response, { id: "bulk_replay" });

    const result = await withApiClient(() =>
      runs.bulk.replay({
        filter: { status: "FAILED", taskIdentifier: ["task-a", "task-b"] },
        name: "Replay failed tasks",
        targetRegion: "eu_1",
      })
    );

    expect(result).toEqual({ id: "bulk_replay" });
    expect(receivedRequests[0]?.method).toBe("POST");
    expect(receivedRequests[0]?.url).toBe("/api/v1/bulk-actions");
    expect(JSON.parse(receivedRequests[0]?.body ?? "{}")).toEqual({
      action: "replay",
      filter: { status: "FAILED", taskIdentifier: ["task-a", "task-b"] },
      name: "Replay failed tasks",
      targetRegion: "eu_1",
    });
  });

  it("retrieves and aborts bulk actions", async () => {
    requestHandler = (request, response) => {
      if (request.method === "GET") {
        return json(response, bulkActionObject("bulk_read", "PENDING"));
      }

      return json(response, { id: "bulk_read" });
    };

    const retrieved = await withApiClient(() => runs.bulk.retrieve("bulk_read"));
    const aborted = await withApiClient(() => runs.bulk.abort("bulk_read"));

    expect(retrieved.id).toBe("bulk_read");
    expect(retrieved.createdAt).toEqual(new Date("2026-07-01T10:00:00.000Z"));
    expect(aborted).toEqual({ id: "bulk_read" });
    expect(receivedRequests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET /api/v1/bulk-actions/bulk_read",
      "POST /api/v1/bulk-actions/bulk_read/abort",
    ]);
  });

  it("lists bulk actions", async () => {
    requestHandler = (_request, response) =>
      json(response, {
        data: [bulkActionObject("bulk_listed", "COMPLETED")],
        pagination: { next: "cursor_next" },
      });

    const page = await withApiClient(() => runs.bulk.list({ limit: 1, before: "cursor_before" }));

    const url = new URL(receivedRequests[0]?.url ?? "", baseUrl);
    expect(receivedRequests[0]?.method).toBe("GET");
    expect(url.pathname).toBe("/api/v1/bulk-actions");
    expect(url.searchParams.get("page[size]")).toBe("1");
    expect(url.searchParams.get("page[before]")).toBe("cursor_before");
    expect(page.data[0]?.id).toBe("bulk_listed");
    expect(page.pagination.next).toBe("cursor_next");
  });

  it("polls until the bulk action finishes", async () => {
    requestHandler = (_request, response) => {
      const status = receivedRequests.length === 1 ? "PENDING" : "COMPLETED";
      return json(response, bulkActionObject("bulk_poll", status));
    };

    const bulkAction = await withApiClient(() =>
      runs.bulk.poll("bulk_poll", { pollIntervalMs: 1 })
    );

    expect(bulkAction.status).toBe("COMPLETED");
    expect(receivedRequests.map((request) => request.url)).toEqual([
      "/api/v1/bulk-actions/bulk_poll",
      "/api/v1/bulk-actions/bulk_poll",
    ]);
  });

  function withApiClient<T>(fn: () => Promise<T>) {
    return apiClientManager.runWithConfig(
      { baseURL: baseUrl, accessToken: "tr_test_key" },
      async () => fn()
    );
  }
});

function json(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function bulkActionObject(id: string, status: "PENDING" | "COMPLETED" | "ABORTED") {
  return {
    id,
    type: "REPLAY",
    status,
    counts: { total: 2, success: status === "COMPLETED" ? 2 : 0, failure: 0 },
    createdAt: "2026-07-01T10:00:00.000Z",
    completedAt: status === "COMPLETED" ? "2026-07-01T10:05:00.000Z" : undefined,
  };
}
