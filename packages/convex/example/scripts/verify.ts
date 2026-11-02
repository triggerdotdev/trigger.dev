import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import { auth, runs } from "@trigger.dev/sdk";
import type { Id } from "../convex/_generated/dataModel";
import { PROCESSOR_VERSION, SAMPLES } from "../shared/catalog.ts";

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const url = env.match(/^VITE_CONVEX_URL=(.+)$/m)?.[1]?.replace(/^"|"$/g, "");
assert(url, "Select a Convex deployment first");
const directory = join(homedir(), ".cache", "convex-image-demo");
const sessionPath = join(directory, "operator-session");
await mkdir(directory, { recursive: true, mode: 0o700 });
let sessionToken: string;
try {
  sessionToken = await readFile(sessionPath, "utf8");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  sessionToken = randomBytes(32).toString("hex");
  await writeFile(sessionPath, sessionToken, { mode: 0o600, flag: "wx" });
}
assert(/^[a-f0-9]{64}$/.test(sessionToken), "Invalid operator session file");
const http = new ConvexHttpClient(url);
const initial = await http.query(api.jobs.board, { sessionToken });
assert.equal(
  (await http.query(api.jobs.board, { sessionToken: randomBytes(32).toString("hex") })).jobs.length,
  0
);
const site = url.replace(".convex.cloud", ".convex.site");
for (const sample of SAMPLES) {
  const response = await fetch(site + sample.file);
  assert.equal(response.status, 200);
  assert(response.headers.get("content-type")?.startsWith("image/"));
  const served = new Uint8Array(await response.arrayBuffer());
  const bundled = await readFile(new URL(`../public${sample.file}`, import.meta.url));
  assert.equal(
    createHash("sha256").update(served).digest("hex"),
    createHash("sha256").update(bundled).digest("hex"),
    `Wrong hosted photograph: ${sample.id}`
  );
}
assert.equal((await fetch(site + "/api/image")).status, 401);
const args = {
  sessionToken,
  sample: "mountains" as const,
  preset: "balanced" as const,
  prompt: "Turn this mountain landscape into a snowy winter scene.",
  requestId: `image-edit-verification-${PROCESSOR_VERSION}`,
};
let jobId = initial.jobs.find(
  (job) => job.sample === args.sample && job.preset === args.preset && job.prompt === args.prompt
)?.id;
if (!jobId && !process.argv.includes("--launch")) {
  console.log(
    JSON.stringify(
      {
        result: "READY",
        samples: SAMPLES.length,
        enabled: initial.quota.enabled,
        budgetUsed: initial.quota.used,
        modelCallTested: false,
        note: "Use --launch to explicitly spend one generation after adding the Gateway key and enabling edits.",
      },
      null,
      2
    )
  );
  process.exit(0);
}
if (!jobId) {
  assert(
    initial.quota.enabled,
    "Edits are paused. Configure the Trigger Gateway key, then enable the demo."
  );
  assert(
    !initial.turnstileSiteKey,
    "Use the browser to complete configured human verification. The CLI does not bypass it."
  );
}
const client = new ConvexClient(url);
const states: Array<{ status: string; stage: string; progress: number }> = [];
const realtimeStates: Array<{
  status: string;
  phase: unknown;
  progress: unknown;
  completedExports: unknown;
}> = [];
const verifyRealtime = process.argv.includes("--realtime");
const REALTIME_TIMEOUT_MS = 120_000;
let observing: Promise<void> | undefined;
let realtimeFailed = false;
let terminalHintAt: number | undefined;
let stopRealtime: (() => void) | undefined;
async function observeRealtime(jobId: string) {
  const credentials = await http.action(api.realtime.token, {
    jobId: jobId as Id<"edits">,
    sessionToken,
  });
  assert(credentials, "No Realtime credentials issued");
  await assert.rejects(
    http.action(api.realtime.token, {
      jobId: jobId as Id<"edits">,
      sessionToken: randomBytes(32).toString("hex"),
    })
  );
  await assert.rejects(
    http.mutation(api.jobs.refresh, {
      jobId: jobId as Id<"edits">,
      sessionToken: randomBytes(32).toString("hex"),
    })
  );
  const headers = { Authorization: `Bearer ${credentials.accessToken}` };
  const own = await fetch(`${credentials.baseURL}/api/v3/runs/${credentials.runId}`, { headers });
  assert.equal(own.status, 200);
  const data = await own.json();
  assert(data.payload && typeof data.payload === "object");
  assert(!("workerToken" in data.payload), "Worker credential exposed in readable payload");
  assert(!("secretKey" in data.payload), "Server credential exposed in readable payload");
  const foreign = await fetch(`${credentials.baseURL}/api/v3/runs/run_06gohij7b965itpig8b2bj6ca2`, {
    headers,
  });
  assert([403, 404].includes(foreign.status), "Realtime token read another run");
  assert.equal(
    (await fetch(`${site}/api/artifacts?jobId=${jobId}&slot=prepared`, { headers })).status,
    401
  );
  await auth.withAuth(
    { secretKey: credentials.accessToken, baseURL: credentials.baseURL },
    async () => {
      const subscription = runs.subscribeToRun(credentials.runId);
      stopRealtime = () => subscription.unsubscribe();
      const timeout = setTimeout(() => {
        realtimeFailed = true;
        subscription.unsubscribe();
      }, REALTIME_TIMEOUT_MS);
      try {
        for await (const run of subscription) {
          assert.equal(run.id, credentials.runId);
          const next = {
            status: run.status,
            phase: run.metadata?.phase,
            progress: run.metadata?.progress,
            completedExports: ["heroReady", "cardReady", "squareReady"].filter(
              (key) => run.metadata?.[key] === true
            ).length,
          };
          if (JSON.stringify(realtimeStates.at(-1)) !== JSON.stringify(next)) {
            realtimeStates.push(next);
            console.log(JSON.stringify({ realtime: next }));
          }
          if (run.isCompleted || run.status === "EXPIRED" || run.status === "TIMED_OUT") {
            terminalHintAt = Date.now();
            await http.mutation(api.jobs.refresh, { jobId: jobId as Id<"edits">, sessionToken });
            break;
          }
        }
      } finally {
        clearTimeout(timeout);
        subscription.unsubscribe();
      }
    }
  );
}
const unsubscribe = client.onUpdate(api.jobs.board, { sessionToken }, (board) => {
  const job = board.jobs.find((job) => job.id === jobId);
  if (!job) return;
  const next = { status: job.status, stage: job.stage, progress: job.progress };
  if (JSON.stringify(states.at(-1)) !== JSON.stringify(next)) {
    states.push(next);
    console.log(JSON.stringify(next));
  }
});
try {
  const first = await http.action(api.jobs.process, args);
  jobId = first.jobId;
  const retry = await http.action(api.jobs.process, args);
  assert.equal(retry.jobId, jobId);
  assert.equal(retry.cached, true);
  const deadline = Date.now() + 10 * 60_000;
  let completed = false;
  while (Date.now() < deadline) {
    const state = await http.query(api.jobs.board, { sessionToken });
    const job = state.jobs.find((job) => job.id === jobId);
    assert(job, "Job disappeared");
    if (job.error) throw new Error(job.error);
    if (verifyRealtime && job.runId && !observing) {
      observing = observeRealtime(job.id).catch((error) => {
        realtimeFailed = true;
        console.error(
          JSON.stringify({ realtimeError: { name: error?.name, status: error?.status } })
        );
      });
    }
    if (job.status === "COMPLETED") {
      const deliveredAt = Date.now();
      assert.equal(job.syncStatus, "complete");
      assert.equal(job.results.length, 3);
      assert.equal(state.quota.active, false);
      for (const result of job.results) {
        const response = await fetch(result.url, {
          headers: { Authorization: `Bearer ${sessionToken}` },
          signal: AbortSignal.timeout(20_000),
        });
        assert.equal(response.status, 200);
        assert(response.headers.get("content-type")?.includes("image/avif"));
        assert(response.headers.get("cache-control")?.includes("no-store"));
        assert.equal((await response.arrayBuffer()).byteLength, result.bytes);
        assert.equal((await fetch(result.url)).status, 401);
        assert.equal(
          (
            await fetch(result.url, {
              headers: { Authorization: `Bearer ${randomBytes(32).toString("hex")}` },
            })
          ).status,
          404
        );
      }
      if (verifyRealtime) {
        assert(observing, "Realtime subscription was not started");
        await observing;
        assert(!realtimeFailed, "Realtime verification failed");
        assert(realtimeStates.length > 0, "No Realtime frames received");
        assert(
          terminalHintAt !== undefined,
          "No authoritative refresh requested from a terminal frame"
        );
      }
      console.log(
        JSON.stringify(
          {
            result: "PASS",
            jobId,
            runId: job.runId,
            processingMs: job.processingMs,
            budgetUsed: state.quota.used,
            subscriptionUpdates: states.length,
            realtimeUpdates: realtimeStates.length,
            terminalHintToDeliveryMs:
              terminalHintAt === undefined || deliveredAt < terminalHintAt
                ? undefined
                : deliveredAt - terminalHintAt,
          },
          null,
          2
        )
      );
      completed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert(completed, "Timed out waiting for image edit");
} finally {
  stopRealtime?.();
  unsubscribe();
  await client.close();
}
