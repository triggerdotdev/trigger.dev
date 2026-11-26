import { ApiClient } from "@trigger.dev/core/v3";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { listRunsTool } from "./runs.js";

async function capture(args: Record<string, unknown>) {
  let request = { path: "", query: {} as Record<string, string> };
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    request = { path: url.pathname, query: Object.fromEntries(url.searchParams) };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [], pagination: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const ctx = {
      options: { devOnly: false },
      getProjectRef: async () => "proj_1",
      getApiClient: async () => new ApiClient(`http://127.0.0.1:${port}`, "tr_dev_test"),
    };
    const res: any = await (listRunsTool.handler as any)(
      { projectRef: "proj_1", environment: "dev", ...args },
      { ctx }
    );
    return { isError: res.isError, ...request };
  } finally {
    server.close();
  }
}

describe("list_runs", () => {
  // Catches: the new filters changing the request a call without them sends.
  it("sends the same request as before when the new filters are not used", async () => {
    expect(
      await capture({ status: "FAILED", taskIdentifier: "my-task", tag: "nightly", limit: 5 })
    ).toEqual({
      isError: undefined,
      path: "/api/v1/runs",
      query: {
        "filter[status]": "FAILED",
        "filter[tag]": "nightly",
        "filter[taskIdentifier]": "my-task",
        "page[size]": "5",
      },
    });
  });

  // Catches: a filter the schema accepts but the handler never sends to the API.
  it("sends the queue, batch, schedule and bulk action filters", async () => {
    let query = new URLSearchParams();
    const server = createServer((req, res) => {
      query = new URL(req.url!, "http://localhost").searchParams;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [], pagination: {} }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const { port } = server.address() as AddressInfo;
      const ctx = {
        options: { devOnly: false },
        getProjectRef: async () => "proj_1",
        getApiClient: async () => new ApiClient(`http://127.0.0.1:${port}`, "tr_dev_test"),
      };

      const res: any = await (listRunsTool.handler as any)(
        {
          projectRef: "proj_1",
          environment: "dev",
          queue: "task/my-task",
          batch: "batch_1",
          schedule: "sched_1",
          bulkAction: "bulk_1",
        },
        { ctx }
      );

      expect(res.isError).toBeFalsy();
      expect(Object.fromEntries(query)).toMatchObject({
        "filter[queue]": "task/my-task",
        "filter[batch]": "batch_1",
        "filter[schedule]": "sched_1",
        "filter[bulkAction]": "bulk_1",
      });
    } finally {
      server.close();
    }
  });
});
