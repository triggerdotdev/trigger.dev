import { ApiClient } from "@trigger.dev/core/v3";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { triggerTaskTool } from "./tasks.js";

async function capture(options: Record<string, unknown> | undefined) {
  let request = { path: "", body: undefined as any };
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      request = { path: new URL(req.url!, "http://localhost").pathname, body: JSON.parse(data) };
      res.setHeader("content-type", "application/json");
      res.setHeader("x-trigger-jwt", "jwt");
      res.end(JSON.stringify({ id: "run_1" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const ctx = {
      options: { devOnly: false },
      getProjectRef: async () => "proj_1",
      getApiClient: async () => new ApiClient(`http://127.0.0.1:${port}`, "tr_prod_test"),
      getDashboardUrl: async (path: string) => `https://cloud.test${path}`,
    };
    const res: any = await (triggerTaskTool.handler as any)(
      { projectRef: "proj_1", environment: "prod", taskId: "my-task", payload: { a: 1 }, options },
      { ctx }
    );
    return { isError: res.isError, ...request };
  } finally {
    server.close();
  }
}

describe("trigger_task", () => {
  // Catches: the tool adding an option the caller did not pass, such as a ttl that replaces the task's own.
  it.each([{ options: { tags: ["a"], maxAttempts: 2 } }, { options: { tags: ["a"], ttl: "5m" } }])(
    "sends only the options the caller passed: $options",
    async ({ options }) => {
      expect(await capture(options)).toEqual({
        isError: undefined,
        path: "/api/v1/tasks/my-task/trigger",
        body: { payload: { a: 1 }, options },
      });
    }
  );

  // Catches: an option the schema accepts but the handler drops before the API call.
  it("sends metadata and the other trigger options to the API", async () => {
    const options = {
      metadata: { user: { id: 7 } },
      idempotencyKeyTTL: "1h",
      concurrencyKey: "user-7",
      concurrency: ["per-org"],
      debounce: { key: "user-7", delay: "5s", mode: "trailing", maxDelay: "1m" },
      lockToVersion: "20250101.1",
      priority: 30,
    };

    const sent = await capture(options);

    expect(sent.isError).toBeUndefined();
    expect(sent.body.options).toEqual(options);
  });

  // Catches: an idempotency key ttl whose expiry the server cannot store reaching the API.
  it("refuses an idempotency key ttl too long to store before sending anything", async () => {
    const sent = await capture({ idempotencyKey: "k", idempotencyKeyTTL: "100000000d" });

    expect({ isError: sent.isError, path: sent.path }).toEqual({ isError: true, path: "" });
  });
});
