import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./index.js";

describe("subscribe methods forward a custom fetchClient", () => {
  let server: Server;
  let baseUrl: string;
  let teardown: AbortController;

  beforeEach(async () => {
    teardown = new AbortController();
    const now = new Date().toISOString().slice(0, -1);
    const run = {
      id: "1",
      friendlyId: "run_1",
      taskIdentifier: "t",
      status: "EXECUTING",
      createdAt: now,
      updatedAt: now,
    };

    server = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "electric-offset": "0_0",
        "electric-handle": "h",
        "electric-schema": "{}",
        "electric-up-to-date": "true",
      });
      response.end(
        JSON.stringify([
          { key: "1", headers: { operation: "insert" }, value: run },
          { headers: { control: "up-to-date" } },
        ])
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    teardown.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function countingFetch() {
    const urls: string[] = [];
    const fetchClient: typeof fetch = (input, init) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return fetch(input, init);
    };
    return { fetchClient, urls };
  }

  const subscriptions = {
    subscribeToRun: (client: ApiClient, fetchClient: typeof fetch, signal: AbortSignal) =>
      client.subscribeToRun("run_1", { fetchClient, signal }),
    subscribeToRunsWithTag: (client: ApiClient, fetchClient: typeof fetch, signal: AbortSignal) =>
      client.subscribeToRunsWithTag("my-tag", undefined, { fetchClient, signal }),
    subscribeToBatch: (client: ApiClient, fetchClient: typeof fetch, signal: AbortSignal) =>
      client.subscribeToBatch("batch_1", { fetchClient, signal }),
  };

  for (const [name, subscribe] of Object.entries(subscriptions)) {
    it(name, async () => {
      const client = new ApiClient(baseUrl, "tr_test");
      const { fetchClient, urls } = countingFetch();

      for await (const run of subscribe(client, fetchClient, teardown.signal)) {
        expect(run.id).toBe("run_1");
        break;
      }

      expect(urls.length).toBeGreaterThan(0);
      expect(urls[0]).toContain(`${baseUrl}/realtime/v1/`);
    });
  }
});
