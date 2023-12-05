import { unstable_dev } from "wrangler";
import type { UnstableDevWorker } from "wrangler";

describe("Wrangler", () => {
  let worker: UnstableDevWorker;

  beforeAll(async () => {
    worker = await unstable_dev("./tests/wrangler/index.ts", {
      vars: {
        TRIGGER_API_KEY: "tr_dev_test-api-key",
        TRIGGER_API_URL: "http://localhost:3030",
      },
      experimental: { disableExperimentalWarning: true },
      compatibilityFlags: ["nodejs_compat"],
      ip: "127.0.0.1",
    });
  });

  afterAll(async () => {
    await worker.stop();
  });

  it("Should be indexable at /api/trigger", async () => {
    const res = await worker.fetch("/api/trigger", {
      method: "POST",
      headers: {
        "x-trigger-api-key": "tr_dev_test-api-key",
        "x-trigger-action": "INDEX_ENDPOINT",
        "x-trigger-version": "2023-11-01",
      },
    });
    expect(res.status).toBe(200);

    const body: any = await res.json();

    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].id).toBe("wrangler-job");
  });
});
