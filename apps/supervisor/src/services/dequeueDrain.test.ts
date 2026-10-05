import type { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SupervisorSession } from "@trigger.dev/core/v3/workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DequeueDrain } from "./dequeueDrain.js";

const logger = {
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as SimpleStructuredLogger;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A platform API whose dequeue responses are held until the test releases them. */
async function startPlatform() {
  const dequeues: Array<(messages: unknown[]) => void> = [];
  const requested = deferred();
  const server = createServer((req, res) => {
    const reply = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url?.endsWith("/connect")) {
      reply({ ok: true, workerGroup: { type: "MANAGED", name: "test" } });
    } else if (req.url?.endsWith("/dequeue")) {
      dequeues.push(reply);
      requested.resolve();
    } else {
      reply({ ok: true });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, dequeues, requested: requested.promise };
}

let platform: Server | undefined;
let session: SupervisorSession | undefined;

afterEach(async () => {
  await session?.stop();
  session = undefined;
  platform?.closeAllConnections();
  await new Promise((resolve) => platform?.close(resolve));
  platform = undefined;
});

function newSession(apiUrl: string, preDequeue?: () => Promise<{ skipDequeue?: boolean }>) {
  return new SupervisorSession({
    apiUrl,
    workerToken: "test-token",
    instanceName: "test",
    heartbeatIntervalSeconds: 60,
    dequeueIntervalMs: 10,
    dequeueIdleIntervalMs: 10,
    runNotificationsEnabled: false,
    scaling: { strategy: "none", maxConsumerCount: 1 },
    preDequeue,
    // The drain cares when messages arrive, not what they hold.
    resolveResponseSchema: <T>(_schema: T) => z.any() as unknown as T,
  });
}

const isSettled = (promise: Promise<unknown>) =>
  Promise.race([promise.then(() => true), new Promise((r) => setTimeout(() => r(false), 50))]);

describe("DequeueDrain", () => {
  it("waits for a dequeue in flight and the handler its message starts", async () => {
    const api = await startPlatform();
    platform = api.server;
    session = newSession(api.url);
    const drain = new DequeueDrain(session, logger);

    const handled: string[] = [];
    const create = deferred();
    session.on(
      "runQueueMessage",
      drain.tracked(async ({ message }) => {
        handled.push((message as unknown as { id: string }).id);
        await create.promise;
      })
    );

    await session.start();
    await api.requested;

    await session.stop();
    const drained = drain.stop();
    expect(await isSettled(drained)).toBe(false);

    api.dequeues[0]!([{ id: "message_1" }]);
    await expect.poll(() => handled).toEqual(["message_1"]);
    expect(await isSettled(drained)).toBe(false);

    create.resolve();
    await drained;
  });

  // Tracking handles the rejection, which would otherwise have crashed the process.
  it("logs a handler that fails, and still drains", async () => {
    const api = await startPlatform();
    platform = api.server;
    session = newSession(api.url);
    const drain = new DequeueDrain(session, logger);

    const handler = drain.tracked(async () => {
      throw new Error("boom");
    });
    await expect(handler()).rejects.toThrow("boom");
    await drain.stop();

    expect(logger.error).toHaveBeenCalledWith("Dequeued message handler failed", { error: "boom" });
  });

  it("makes no request for a consumer stopped during its pre-dequeue check", async () => {
    const api = await startPlatform();
    platform = api.server;
    const checking = deferred();
    const check = deferred<{ skipDequeue?: boolean }>();
    session = newSession(api.url, () => {
      checking.resolve();
      return check.promise;
    });
    const drain = new DequeueDrain(session, logger);

    await session.start();
    await checking.promise;

    await session.stop();
    await drain.stop();
    check.resolve({});

    expect(await isSettled(api.requested)).toBe(false);
    expect(api.dequeues).toHaveLength(0);
  });
});
