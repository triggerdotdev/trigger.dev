import type {
  MachinePresetResources,
  ServerBackgroundWorker,
  WorkerManifest,
} from "@trigger.dev/core/v3";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TaskRunProcess } from "../../executions/taskRunProcess.js";
import { UsageJwtRefresher } from "./usageJwtRefresh.js";
import { DevUsageManager, ProdUsageManager } from "@trigger.dev/core/v3/workers";

const childPath = fileURLToPath(
  new URL("../../../test/fixtures/usageJwtChild.ts", import.meta.url)
);
const tsxLoader = createRequire(import.meta.url).resolve("tsx");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function token(exp: number, overrides: Record<string, unknown> = {}) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const content = `${encode({ alg: "HS256" })}.${encode({
    exp,
    run_id: "a",
    usage_auth: "control-plane-v1",
    usage_attempt: "2",
    ...overrides,
  })}`;
  return `${content}.${createHmac("sha256", "test-secret").update(content).digest("base64url")}`;
}

function startChild(env: Record<string, string>) {
  const child = new TaskRunProcess({
    workerManifest: {
      runtime: "node",
      workerEntryPoint: childPath,
      loaderEntryPoint: tsxLoader,
      configEntryPoint: childPath,
    } as unknown as WorkerManifest,
    serverWorker: {} as ServerBackgroundWorker,
    env,
    machineResources: { cpu: 1, memory: 1 } as MachinePresetResources,
  }).initialize();
  cleanups.push(() => child.kill("SIGKILL"));
  return child;
}

describe("billing JWT refresh", () => {
  // Catches: an unused TRIGGER_JWT forcing non-metered executions to fail after a long wait.
  it("does not request or enforce renewal when usage reporting is disabled", () => {
    const expiredJwt = token(Math.floor(Date.now() / 1_000) - 7_200, { usage_auth: undefined });
    for (const usageOptions of [
      { jwt: expiredJwt },
      { jwt: expiredJwt, url: "http://localhost" },
      { jwt: expiredJwt, heartbeatIntervalMs: 60_000 },
      { jwt: expiredJwt, url: "http://localhost", heartbeatIntervalMs: 0 },
    ]) {
      const manager = new ProdUsageManager(new DevUsageManager(), usageOptions);
      const refresher = new UsageJwtRefresher({
        runId: "run_a",
        attemptNumber: 2,
        usageOptions,
        install: async (update) => manager.setJwt(update.token),
      });
      expect(manager.isReportingEnabled).toBe(false);
      expect(refresher.fallbackReason).toBeUndefined();
      expect(refresher.report()).toBeUndefined();
      expect(refresher.isDue).toBe(false);
    }
  });

  // Catches: a non-renewable initial credential failing the run instead of falling back.
  it("falls back for non-renewable initial credentials without requesting or installing renewals", async () => {
    const now = Math.floor(Date.now() / 1_000);
    for (const jwt of [
      token(now + 3_600, { usage_auth: undefined }),
      token(now + 3_600, { run_id: "other" }),
      token(now + 3_600, { usage_attempt: "1" }),
      "invalid-jwt",
    ]) {
      let installed = false;
      const refresher = new UsageJwtRefresher({
        runId: "run_a",
        attemptNumber: 2,
        usageOptions: { jwt, url: "http://localhost", heartbeatIntervalMs: 60_000 },
        install: async () => {
          installed = true;
          return true;
        },
      });
      expect(refresher.fallbackReason).toBeDefined();
      expect(refresher.report()).toBeUndefined();
      expect(refresher.isDue).toBe(false);
      expect(await refresher.installReplacement(token(now + 3_600))).toBe(false);
      expect(installed).toBe(false);
    }
  });

  // Catches: resuming with an expired cached UsageClient JWT even after the runner received a replacement.
  it("installs into the actual child usage client before releasing a wait longer than its JWT lifetime, without a root key", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const initial = token(now - 3_600);
    const replacement = token(now + 3_600);
    const requests: { authorization?: string; jwt?: string; durationMs: number }[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({
        authorization: req.headers.authorization,
        jwt: req.headers["x-trigger-jwt"] as string,
        durationMs: JSON.parse(Buffer.concat(chunks).toString()).durationMs,
      });
      res.writeHead(req.headers["x-trigger-jwt"] === replacement ? 200 : 401).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    const child = startChild({
      TRIGGER_JWT: initial,
      USAGE_EVENT_URL: `http://127.0.0.1:${address.port}`,
    });
    let currentTime = (now - 7_200) * 1_000;
    const refresher = new UsageJwtRefresher({
      runId: "run_a",
      attemptNumber: 2,
      usageOptions: {
        jwt: initial,
        url: `http://127.0.0.1:${address.port}`,
        heartbeatIntervalMs: 60_000,
      },
      install: (update) => child.installUsageJwt(update),
      now: () => currentTime,
    });
    expect(refresher.isDue).toBe(false);
    currentTime += 2 * 60 * 60 * 1_000;
    expect(refresher.isDue).toBe(true);
    expect(await refresher.installReplacement(replacement)).toBe(true);
    expect(refresher.isDue).toBe(false);
    child.waitpointCompleted({
      id: "wait_1",
      friendlyId: "waitpoint_1",
      type: "DATETIME",
      completedAt: new Date(),
      outputIsError: false,
    });
    const flushed = child.onSendDebugLog.waitFor(10_000);
    await child.cleanup(false);
    expect((await flushed).message).toBe("flushed");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ authorization: undefined, jwt: replacement });
    expect(requests[0]!.durationMs).toBeGreaterThan(0);
  }, 20_000);

  // Catches: an unacknowledged or wrong-attempt replacement suppressing subsequent renewal requests.
  it("keeps renewal due when a legacy child cannot install, and rejects another attempt", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const initial = token(now - 7_200);
    const child = startChild({ TRIGGER_JWT: initial, FIXTURE_LEGACY_CHILD: "1" });
    const refresher = new UsageJwtRefresher({
      runId: "run_a",
      attemptNumber: 2,
      usageOptions: { jwt: initial, url: "http://localhost", heartbeatIntervalMs: 60_000 },
      install: (update) => child.installUsageJwt(update),
    });
    expect(await refresher.installReplacement(token(now + 3_600))).toBe(false);
    expect(refresher.isDue).toBe(true);
    expect(await refresher.installReplacement(token(now + 3_600, { usage_attempt: "1" }))).toBe(
      false
    );
    expect(refresher.report()?.attemptNumber).toBe(2);
  }, 20_000);
});
