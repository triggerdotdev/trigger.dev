// Load apps/webapp/.env into process.env so env.server's top-level
// EnvironmentSchema.parse(process.env) succeeds in vitest workers.
import { config } from "dotenv";
import path from "node:path";
import { vi } from "vitest";

config({ path: path.resolve(__dirname, "../.env") });

// Worker singletons construct a RedisWorker at import time whose ioredis client
// connects eagerly, so any test importing the service graph opens real Redis
// connections on import — which floods and fails in CI (no Redis). Mock them to
// no-op stubs. Only the worker modules are mocked, never the run store
// (~/v3/runStore.server, ~/db.server), which store-routing tests need real.
function createWorkerStub() {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    enqueue: vi.fn().mockResolvedValue(undefined),
    enqueueOnce: vi.fn().mockResolvedValue(undefined),
    reschedule: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    ack: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock("~/v3/commonWorker.server", () => ({ commonWorker: createWorkerStub() }));
vi.mock("~/v3/batchTriggerWorker.server", () => ({ batchTriggerWorker: createWorkerStub() }));
vi.mock("~/v3/legacyRunEngineWorker.server", () => ({
  legacyRunEngineWorker: createWorkerStub(),
}));
vi.mock("~/v3/alertsWorker.server", () => ({ alertsWorker: createWorkerStub() }));

// RunEngine, MarQS, devPubSub and the socket.io server are further singletons
// that open eager ioredis connections at import via the same pattern. No test
// uses these app-level singletons directly (store-routing tests build their own
// engine and run store), so stub them to no-op proxies.
const noopProxy = () =>
  new Proxy(
    {},
    {
      get: () => vi.fn().mockResolvedValue(undefined),
    }
  );

vi.mock("~/v3/runEngine.server", () => ({ engine: noopProxy() }));
vi.mock("~/v3/marqs/index.server", () => ({ marqs: noopProxy(), MarQS: class {} }));
vi.mock("~/v3/marqs/devPubSub.server", () => ({ devPubSub: noopProxy() }));
vi.mock("~/v3/handleSocketIo.server", () => ({
  socketIo: noopProxy(),
  roomFromFriendlyRunId: (id: string) => `room:${id}`,
}));
