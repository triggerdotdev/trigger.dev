import { getEventListeners } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./index.js";
import {
  RunSubscription,
  type SSEStreamPart,
  type StreamSubscription,
  type StreamSubscriptionFactory,
} from "./runStream.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("RunSubscription cancellation", () => {
  let server: Server;
  let baseUrl: string;
  let requests: number;
  let teardown: AbortController;
  let runFields: Record<string, unknown>;

  beforeEach(async () => {
    requests = 0;
    teardown = new AbortController();
    runFields = {};
    const now = new Date().toISOString().slice(0, -1);
    const run = {
      id: "1",
      friendlyId: "run_1",
      taskIdentifier: "t",
      status: "EXECUTING",
      createdAt: now,
      updatedAt: now,
    };

    server = createServer((request, response) => {
      requests++;
      // Each new subscription starts at offset -1 and gets the run; live polls get nothing new
      const initial = new URL(request.url ?? "/", baseUrl).searchParams.get("offset") === "-1";
      const messages = initial
        ? [
            { key: "1", headers: { operation: "insert" }, value: { ...run, ...runFields } },
            { headers: { control: "up-to-date" } },
          ]
        : [{ headers: { control: "up-to-date" } }];

      response.writeHead(200, {
        "content-type": "application/json",
        "electric-offset": `0_${requests}`,
        "electric-handle": "h",
        "electric-schema": "{}",
        "electric-cursor": `${requests}`,
        "electric-up-to-date": "true",
      });
      response.end(JSON.stringify(messages));
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

  async function requestsAfterSettling() {
    await sleep(100);
    const settled = requests;
    await sleep(400);
    return { settled, later: requests };
  }

  it("stops polling when the consumer breaks without aborting", async () => {
    const client = new ApiClient(baseUrl, "tr_test");
    let pollsWhileIterating = 0;

    for await (const run of client.subscribeToRun("run_1", { signal: teardown.signal })) {
      expect(run.id).toBe("run_1");
      const before = requests;
      await sleep(200);
      pollsWhileIterating = requests - before;
      break;
    }

    // Proves live polling was running before the break
    expect(pollsWhileIterating).toBeGreaterThan(1);

    const { settled, later } = await requestsAfterSettling();
    expect(later).toBe(settled);
  });

  it("stops polling when the consumer breaks out of withStreams()", async () => {
    const client = new ApiClient(baseUrl, "tr_test");

    for await (const part of client
      .subscribeToRun("run_1", { signal: teardown.signal })
      .withStreams()) {
      expect(part.type).toBe("run");
      break;
    }

    const { settled, later } = await requestsAfterSettling();
    expect(later).toBe(settled);
  });

  const pendingTimers = () =>
    process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;

  it("does not leave a pending stop timer after breaking on a completed run", async () => {
    runFields = {
      status: "COMPLETED_SUCCESSFULLY",
      completedAt: new Date().toISOString().slice(0, -1),
    };
    const client = new ApiClient(baseUrl, "tr_test");
    const baseline = pendingTimers();

    for await (const run of client.subscribeToRun("run_1", { signal: teardown.signal })) {
      expect(run.status).toBe("COMPLETED");
      expect(run.finishedAt).toBeInstanceOf(Date);
      break;
    }
    await sleep(50);

    expect(pendingTimers()).toBeLessThanOrEqual(baseline);
  });

  it("does not leave a pending stop timer after unsubscribe()", async () => {
    const client = new ApiClient(baseUrl, "tr_test");
    const baseline = pendingTimers();
    const subscription = client.subscribeToRun("run_1", { signal: teardown.signal });

    for await (const _ of subscription) {
      subscription.unsubscribe();
    }
    await sleep(50);

    expect(pendingTimers()).toBeLessThanOrEqual(baseline);
  });

  it("ends iteration and stops polling once the run completes", async () => {
    runFields = {
      status: "COMPLETED_SUCCESSFULLY",
      completedAt: new Date().toISOString().slice(0, -1),
    };
    const client = new ApiClient(baseUrl, "tr_test");
    const shared = new AbortController();
    const baseline = pendingTimers();
    const statuses: string[] = [];

    const iterate = (async () => {
      for await (const run of client.subscribeToRun("run_1", { signal: shared.signal })) {
        statuses.push(run.status);
      }
      return "ended" as const;
    })();

    const outcome = await Promise.race([iterate, sleep(2_000).then(() => "timeout" as const)]);
    teardown.abort();
    if (outcome === "timeout") {
      shared.abort();
    }

    expect(outcome).toBe("ended");
    expect(statuses).toEqual(["COMPLETED"]);
    const { settled, later } = await requestsAfterSettling();
    expect(later).toBe(settled);
    expect(pendingTimers()).toBeLessThanOrEqual(baseline);
    expect(getEventListeners(shared.signal, "abort")).toHaveLength(0);
  });

  it("keeps iterating after the run completes when closeOnComplete is false", async () => {
    runFields = {
      status: "COMPLETED_SUCCESSFULLY",
      completedAt: new Date().toISOString().slice(0, -1),
    };
    const client = new ApiClient(baseUrl, "tr_test");
    const subscription = client.subscribeToRun("run_1", {
      signal: teardown.signal,
      closeOnComplete: false,
    });

    const iterate = (async () => {
      for await (const _ of subscription) {
      }
      return "ended" as const;
    })();

    const outcome = await Promise.race([iterate, sleep(500).then(() => "open" as const)]);
    const before = requests;
    await sleep(200);

    expect(outcome).toBe("open");
    expect(requests).toBeGreaterThan(before);
    subscription.unsubscribe();
    await iterate;
  });

  it("removes its listener from a shared signal when the consumer breaks", async () => {
    const client = new ApiClient(baseUrl, "tr_test");
    const shared = new AbortController();

    for (let i = 0; i < 20; i++) {
      for await (const _ of client.subscribeToRun("run_1", { signal: shared.signal })) {
        break;
      }
    }

    expect(getEventListeners(shared.signal, "abort")).toHaveLength(0);
    shared.abort();
  });

  it("does not throw when the signal aborts after the consumer breaks", async () => {
    const client = new ApiClient(baseUrl, "tr_test");
    const abort = new AbortController();

    for await (const run of client.subscribeToRun("run_1", { signal: abort.signal })) {
      expect(run.status).toBe("EXECUTING");
      break;
    }

    abort.abort();
    await sleep(50);
  });
});

// Emits a stream part every millisecond until cancelled, so parts are still arriving after a break
class TickingStreamFactory implements StreamSubscriptionFactory {
  cancelled = 0;

  createSubscription(): StreamSubscription {
    return {
      subscribe: async () => {
        let timer: ReturnType<typeof setInterval> | undefined;
        return new ReadableStream<SSEStreamPart<unknown>>({
          start(controller) {
            let i = 0;
            timer = setInterval(() => {
              i++;
              controller.enqueue({ id: `${i}`, chunk: { i }, timestamp: Date.now() });
            }, 1);
          },
          cancel: () => {
            this.cancelled++;
            clearInterval(timer);
          },
        });
      },
    };
  }
}

describe("RunSubscription.withStreams cancellation", () => {
  it("does not throw when stream parts keep arriving after the consumer breaks", async () => {
    const streamFactory = new TickingStreamFactory();
    const run = {
      id: "123",
      friendlyId: "run_123",
      taskIdentifier: "t",
      status: "EXECUTING",
      createdAt: new Date(),
      updatedAt: new Date(),
      number: 1,
      usageDurationMs: 100,
      costInCents: 0,
      baseCostInCents: 0,
      isTest: false,
      runTags: [],
      metadata: JSON.stringify({}),
      metadataType: "application/json",
      realtimeStreams: ["openai"],
    };

    const subscription = new RunSubscription({
      runShapeStream: new ReadableStream({
        start(controller) {
          controller.enqueue(run as any);
        },
      }),
      stopRunShapeStream: () => {},
      streamFactory,
      abortController: new AbortController(),
    });

    let parts = 0;
    for await (const part of subscription.withStreams()) {
      if (part.type === "openai" && ++parts === 3) break;
    }

    await sleep(100);
    expect(streamFactory.cancelled).toBe(1);
  });
});
