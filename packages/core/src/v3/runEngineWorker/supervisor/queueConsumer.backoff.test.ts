import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { SupervisorHttpClient } from "./http.js";
import { RunQueueConsumer } from "./queueConsumer.js";

const HTTP_BACKOFF_TEST_TIMEOUT_MS = 20_000;

it.each([403, 422])(
  "backs off repeated HTTP %s responses and resets after success",
  async (status) => {
    let responseStatus = status;
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(responseStatus, { "content-type": "application/json" });
      response.end(
        JSON.stringify(responseStatus === 200 ? [] : { error: "Rejected subscription" })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    let pollComplete: () => void = () => {};
    function nextPoll() {
      return new Promise<void>((resolve) => {
        pollComplete = resolve;
      });
    }
    const client = new SupervisorHttpClient({
      apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      workerToken: "local-test-token",
      instanceName: "backoff-test",
      onHttpRequestComplete: () => pollComplete(),
    });
    const consumer = new RunQueueConsumer({
      client,
      intervalMs: 50,
      idleIntervalMs: 100,
      onDequeue: async () => {},
    });

    async function advanceToNextPoll(delayMs: number) {
      const before = requests;
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(requests).toBe(before);
      const complete = nextPoll();
      await vi.advanceTimersByTimeAsync(1);
      await complete;
      await setImmediate();
      expect(requests).toBe(before + 1);
    }

    try {
      const complete = nextPoll();
      consumer.start();
      await complete;
      await setImmediate();
      expect(requests).toBe(1);

      for (const delayMs of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
        await advanceToNextPoll(delayMs);
      }

      responseStatus = 200;
      await advanceToNextPoll(30_000);
      responseStatus = status;
      await advanceToNextPoll(100);
      await advanceToNextPoll(1_000);
    } finally {
      consumer.stop();
      vi.clearAllTimers();
      vi.useRealTimers();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  HTTP_BACKOFF_TEST_TIMEOUT_MS
);
