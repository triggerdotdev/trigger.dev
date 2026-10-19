import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A throwaway Redis Cluster of local server processes, for tests that must catch CROSSSLOT: a
 * standalone Redis (or a test container) runs a multi-slot script without complaint. Needs
 * `valkey-server` or `redis-server`, with its CLI, on the machine, so tests gate on
 * `hasLocalRedisServer()`.
 */
export type LocalRedisCluster = {
  nodes: Array<{ host: string; port: number }>;
  /** Run a CLI command against one node and return its output. */
  cli(port: number, ...args: string[]): string;
  /** Kill a node outright, the way a crash would. */
  kill(port: number): void;
  stop(): Promise<void>;
};

const BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

function findBinary(names: string[]): string | undefined {
  for (const name of names) {
    for (const dir of BIN_DIRS) {
      const path = join(dir, name);
      if (existsSync(path)) return path;
    }
  }
  return undefined;
}

function binaries() {
  const server = findBinary(["valkey-server", "redis-server"]);
  const cli = findBinary(["valkey-cli", "redis-cli"]);
  return server && cli ? { server, cli } : undefined;
}

export function hasLocalRedisServer(): boolean {
  return binaries() !== undefined;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

async function until(check: () => boolean, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (check()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("local Redis Cluster did not come up");
}

export async function startLocalRedisCluster(
  options: { primaries?: number; replicas?: number; nodeTimeoutMs?: number } = {}
): Promise<LocalRedisCluster> {
  const bins = binaries();
  if (!bins) throw new Error("startLocalRedisCluster needs valkey-server or redis-server on PATH");

  const primaries = options.primaries ?? 3;
  const replicas = options.replicas ?? 0;
  const dir = mkdtempSync(join(tmpdir(), "local-redis-cluster-"));
  const ports: number[] = [];
  const procs = new Map<number, ChildProcess>();

  for (let i = 0; i < primaries * (1 + replicas); i++) {
    const port = await freePort();
    const busPort = await freePort();
    ports.push(port);
    procs.set(
      port,
      spawn(
        bins.server,
        [
          "--port",
          String(port),
          "--cluster-enabled",
          "yes",
          "--cluster-port",
          String(busPort),
          "--cluster-config-file",
          join(dir, `nodes-${port}.conf`),
          "--cluster-node-timeout",
          String(options.nodeTimeoutMs ?? 2000),
          "--dir",
          dir,
          "--save",
          "",
          "--appendonly",
          "no",
          "--maxmemory-policy",
          "noeviction",
        ],
        { stdio: "ignore" }
      )
    );
  }

  const cli = (port: number, ...args: string[]) =>
    execFileSync(bins.cli, ["-p", String(port), ...args], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();

  for (const port of ports) {
    await until(() => cli(port, "ping") === "PONG", 20_000);
  }
  execFileSync(
    bins.cli,
    [
      "--cluster",
      "create",
      ...ports.map((port) => `127.0.0.1:${port}`),
      "--cluster-replicas",
      String(replicas),
      "--cluster-yes",
    ],
    { stdio: "ignore" }
  );
  await until(
    () => ports.every((port) => cli(port, "cluster", "info").includes("cluster_state:ok")),
    30_000
  );

  return {
    nodes: ports.map((port) => ({ host: "127.0.0.1", port })),
    cli,
    kill(port) {
      procs.get(port)?.kill("SIGKILL");
    },
    async stop() {
      for (const port of ports) {
        try {
          cli(port, "shutdown", "nosave");
        } catch {}
      }
      for (const proc of procs.values()) proc.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
