import { WORKLOAD_HEADERS } from "@trigger.dev/core/v3/workers";
import { io, type Socket } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("std-env", () => ({
  env: {
    TRIGGER_API_URL: "http://localhost:3030",
    TRIGGER_WORKER_TOKEN: "test-token",
    MANAGED_WORKER_SECRET: "test-secret",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  },
}));

const { WorkloadServer } = await import("./index.js");

const PORT = 18752;

const servers: InstanceType<typeof WorkloadServer>[] = [];
let client: Socket | undefined;

afterEach(async () => {
  client?.close();
  client = undefined;
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function startServer() {
  const server = new WorkloadServer({
    port: PORT,
    workerClient: {} as any,
    wideEventOpts: { service: "supervisor", env: { nodeId: "test" }, enabled: false },
    wideEventsNoisyRoutes: false,
  });
  await server.start();
  servers.push(server);
  return server;
}

function nextEvent<T extends unknown[]>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, (...args: unknown[]) => resolve(args as T)));
}

describe("WorkloadServer stop", () => {
  it("drops runner sockets so they reconnect to the next server", async () => {
    const first = await startServer();

    // The same client options as the managed runner, with a short reconnection delay.
    client = io(`http://127.0.0.1:${PORT}/workload`, {
      transports: ["websocket"],
      extraHeaders: {
        [WORKLOAD_HEADERS.DEPLOYMENT_ID]: "deployment_1",
        [WORKLOAD_HEADERS.RUNNER_ID]: "runner_1",
      },
      reconnectionDelay: 50,
      reconnectionDelayMax: 50,
    });
    await nextEvent(client, "connect");

    const disconnected = nextEvent<[string]>(client, "disconnect");
    await first.stop();
    servers.splice(servers.indexOf(first), 1);

    const [reason] = await disconnected;
    expect(reason).toBe("transport close");
    expect(client.active).toBe(true);

    const reconnected = nextEvent(client, "connect");
    await startServer();
    await reconnected;
    expect(client.connected).toBe(true);
  });
});
