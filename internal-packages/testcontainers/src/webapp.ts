import { spawn } from "child_process";
import { createServer } from "net";
import { delimiter, resolve } from "path";
import { Network } from "testcontainers";
import { PrismaClient } from "@trigger.dev/database";
import { createPostgresContainer } from "./utils";

const WEBAPP_ROOT = resolve(__dirname, "../../../apps/webapp");
// pnpm hoists transitive deps to node_modules/.pnpm/node_modules but does NOT symlink them
// to the root node_modules. We need NODE_PATH so the webapp process can find them at runtime.
const PNPM_HOISTED_MODULES = resolve(__dirname, "../../../node_modules/.pnpm/node_modules");

async function findFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      srv.close((err) => (err ? rej(err) : res(port)));
    });
  });
}

async function waitForHealthcheck(url: string, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Webapp did not become healthy at ${url} within ${timeoutMs}ms`);
}

export interface WebappInstance {
  baseUrl: string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export async function startWebapp(databaseUrl: string): Promise<{
  instance: WebappInstance;
  stop: () => Promise<void>;
}> {
  const port = await findFreePort();

  // Merge NODE_PATH so transitive pnpm deps (hoisted to .pnpm/node_modules) are resolvable
  const existingNodePath = process.env.NODE_PATH;
  const nodePath = existingNodePath
    ? `${PNPM_HOISTED_MODULES}${delimiter}${existingNodePath}`
    : PNPM_HOISTED_MODULES;

  const proc = spawn(process.execPath, ["build/server.js"], {
    cwd: WEBAPP_ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      DIRECT_URL: databaseUrl,
      PORT: String(port),
      REMIX_APP_PORT: String(port), // override .env file value (vitest loads .env via Vite)
      SESSION_SECRET: "test-session-secret-for-e2e-tests",
      MAGIC_LINK_SECRET: "test-magic-link-secret-32chars!!",
      ENCRYPTION_KEY: "test-encryption-key-for-e2e!!!!!", // exactly 32 bytes
      CLICKHOUSE_URL: "http://localhost:19123", // dummy, auth paths never connect
      DEPLOY_REGISTRY_HOST: "registry.example.com", // dummy, not needed for auth tests
      ELECTRIC_ORIGIN: "http://localhost:3060",
      NODE_PATH: nodePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderr: string[] = [];
  proc.stderr?.on("data", (d: Buffer) => {
    const line = d.toString();
    stderr.push(line);
    if (process.env.WEBAPP_TEST_VERBOSE) {
      process.stderr.write(line);
    }
  });

  const stdout: string[] = [];
  proc.stdout?.on("data", (d: Buffer) => {
    const line = d.toString();
    stdout.push(line);
    if (process.env.WEBAPP_TEST_VERBOSE) {
      process.stdout.write(line);
    }
  });

  // Capture spawn errors instead of throwing from inside the listener.
  // A synchronous throw from an EventEmitter listener bypasses the surrounding
  // try/catch and surfaces as an uncaughtException, tearing down the test runner.
  let spawnError: Error | undefined;
  proc.on("error", (err) => {
    spawnError = err;
  });

  const baseUrl = `http://localhost:${port}`;

  try {
    if (spawnError) throw spawnError;
    await waitForHealthcheck(`${baseUrl}/healthcheck`);
    if (spawnError) throw spawnError;
  } catch (err) {
    proc.kill("SIGTERM");
    const output = [...stdout, ...stderr].join("\n");
    throw new Error(`Webapp failed to start.\nOutput:\n${output}\n\nOriginal error: ${err}`);
  }

  return {
    instance: {
      baseUrl,
      fetch: (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init),
    },
    stop: () =>
      new Promise<void>((res) => {
        const timer = setTimeout(() => {
          proc.kill("SIGKILL");
          res();
        }, 10_000);
        proc.once("exit", () => {
          clearTimeout(timer);
          res();
        });
        proc.kill("SIGTERM");
      }),
  };
}

export interface TestServer {
  webapp: WebappInstance;
  prisma: PrismaClient;
  stop: () => Promise<void>;
}

/** Convenience helper: starts a postgres container + webapp and returns both for testing. */
export async function startTestServer(): Promise<TestServer> {
  const network = await new Network().start();

  // Track each resource as we acquire it so we can tear it down if a later step fails.
  // Without this, a healthcheck timeout in startWebapp() would leak the postgres
  // container, network, and PrismaClient connection indefinitely.
  let container: Awaited<ReturnType<typeof createPostgresContainer>>["container"] | undefined;
  let prisma: PrismaClient | undefined;
  let stopWebapp: (() => Promise<void>) | undefined;
  let webapp: WebappInstance;

  try {
    const pg = await createPostgresContainer(network);
    container = pg.container;
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } });
    const started = await startWebapp(pg.url);
    webapp = started.instance;
    stopWebapp = started.stop;
  } catch (err) {
    await stopWebapp?.().catch(() => {});
    await prisma?.$disconnect().catch(() => {});
    await container?.stop().catch(() => {});
    await network.stop().catch(() => {});
    throw err;
  }

  const stop = async () => {
    await stopWebapp!().catch((err) => console.error("stopWebapp failed:", err));
    await prisma!.$disconnect().catch((err) => console.error("prisma.$disconnect failed:", err));
    await container!.stop().catch((err) => console.error("container.stop failed:", err));
    await network.stop().catch((err) => console.error("network.stop failed:", err));
  };

  return { webapp, prisma: prisma!, stop };
}
