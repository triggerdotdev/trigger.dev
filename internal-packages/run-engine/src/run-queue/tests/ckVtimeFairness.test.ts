import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { Decimal } from "@trigger.dev/database";
import { appendFileSync } from "node:fs";
import { describe } from "node:test";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import type { InputPayload } from "../types.js";

// Fairness scenarios driven through the REAL batched dequeue path (maxCount 10),
// closing the spike's maxCount=1 fidelity gap. Every assertion is a ratio between
// a flag-ON and a flag-OFF run of the same scenario (identical enqueue order and
// timestamps), so the tests are stable in CI.
//
// Scenario shapes are ported from the throwaway fairness spike (ckScenarios.ts /
// capsFairness.bench.test.ts): the message counts and head-age structure are
// copied as values, nothing is imported from the spike.
//
// Harness: a deterministic step loop. All messages are enqueued before step 0
// with explicit past timestamps (a pre-existing backlog), so every message's
// logical arrival step is 0 and its wait is simply the step it was served at.
// Each step makes one dequeue call with maxCount 10, records the serves, then
// acks in-flight messages whose logical hold has elapsed (servedAt + hold <=
// step), which is how the env concurrency contends across steps. No wall-clock
// sleeps and no randomness anywhere.

const testOptions = {
  name: "rq",
  tracer: trace.getTracer("rq"),
  workers: 1,
  defaultEnvConcurrency: 25,
  logger: new Logger("RunQueue", "warn"),
  retryOptions: {
    maxAttempts: 5,
    factor: 1.1,
    minTimeoutInMs: 100,
    maxTimeoutInMs: 1_000,
    randomize: true,
  },
  keys: new RunQueueFullKeyProducer(),
};

const authenticatedEnvDev = {
  id: "e1234",
  type: "DEVELOPMENT" as const,
  maximumConcurrencyLimit: 10,
  concurrencyLimitBurstFactor: new Decimal(2.0),
  project: { id: "p1234" },
  organization: { id: "o1234" },
};

function createQueue(redisContainer: any, keyPrefix: string, vtimeEnabled: boolean) {
  return new RunQueue({
    ...testOptions,
    // The step loop drives every op itself (testDequeueFromMasterQueue +
    // skipDequeueProcessing), so the autonomous master-queue consumers and the
    // background worker must not race it.
    masterQueueConsumersDisabled: true,
    workerOptions: { disabled: true },
    ckVirtualTimeScheduling: {
      enabled: vtimeEnabled,
    },
    queueSelectionStrategy: new FairQueueSelectionStrategy({
      redis: {
        keyPrefix,
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
      },
      keys: testOptions.keys,
    }),
    redis: {
      keyPrefix,
      host: redisContainer.getHost(),
      port: redisContainer.getPort(),
    },
  });
}

function makeMessage(overrides: Partial<InputPayload> = {}): InputPayload {
  return {
    runId: "r1",
    taskIdentifier: "task/my-task",
    orgId: "o1234",
    projectId: "p1234",
    environmentId: "e1234",
    environmentType: "DEVELOPMENT",
    queue: "task/my-task",
    timestamp: Date.now(),
    attempt: 0,
    ...overrides,
  };
}

type ScenarioMessage = { runId: string; ck: string; timestamp: number };

type Scenario = {
  name: string;
  messages: ScenarioMessage[];
  // Effective env concurrency for the run (burst factor is pinned to 1.0).
  // This is the contention knob: it caps how many serves fit in one dequeue
  // call (actualMaxCount = min(maxCount, available env capacity)).
  envConcurrencyLimit: number;
  // Logical hold: a served message occupies its env slot until the end of
  // step servedAt + holdSteps, when it is acked.
  holdSteps: number;
  // Safety cap so a work-conservation bug fails the count assertions instead
  // of hanging the test.
  maxSteps: number;
};

type ServeRecord = { step: number; ck: string; messageId: string };

type ScenarioResult = {
  serves: ServeRecord[];
  // step at which the last message was served
  drainStep: number;
  // serves that happened in steps where >= 2 keys still had queued backlog
  contentionServes: { total: number; byCk: Map<string, number> };
};

async function runScenario(
  redisContainer: any,
  scenario: Scenario,
  vtimeEnabled: boolean
): Promise<ScenarioResult> {
  // Separate key prefix per run: the ON and OFF runs of a scenario share one
  // Redis container but never share state.
  const keyPrefix = `runqueue:test:${scenario.name}:${vtimeEnabled ? "on" : "off"}:`;
  const queue = createQueue(redisContainer, keyPrefix, vtimeEnabled);

  try {
    const env = {
      ...authenticatedEnvDev,
      maximumConcurrencyLimit: scenario.envConcurrencyLimit,
      concurrencyLimitBurstFactor: new Decimal(1),
    };
    await queue.updateEnvConcurrencyLimits(env);

    for (const msg of scenario.messages) {
      await queue.enqueueMessage({
        env,
        message: makeMessage({
          runId: msg.runId,
          concurrencyKey: msg.ck,
          timestamp: msg.timestamp,
        }),
        workerQueue: env.id,
        skipDequeueProcessing: true,
      });
    }

    const shard = testOptions.keys.masterQueueShardForEnvironment(env.id, 2);
    const total = scenario.messages.length;

    const remaining = new Map<string, number>();
    for (const m of scenario.messages) {
      remaining.set(m.ck, (remaining.get(m.ck) ?? 0) + 1);
    }

    const serves: ServeRecord[] = [];
    const inFlight: { messageId: string; servedAtStep: number }[] = [];
    const contentionServes = { total: 0, byCk: new Map<string, number>() };
    let drainStep = -1;

    for (let step = 0; step < scenario.maxSteps && serves.length < total; step++) {
      // evaluated before the dequeue: does this step have cross-key contention?
      let keysWithBacklog = 0;
      for (const count of remaining.values()) {
        if (count > 0) keysWithBacklog++;
      }

      const messages = await queue.testDequeueFromMasterQueue(shard, env.id, 10);

      for (const m of messages) {
        const ck = m.message.concurrencyKey ?? "";
        serves.push({ step, ck, messageId: m.messageId });
        remaining.set(ck, (remaining.get(ck) ?? 0) - 1);
        inFlight.push({ messageId: m.messageId, servedAtStep: step });
        if (keysWithBacklog >= 2) {
          contentionServes.total++;
          contentionServes.byCk.set(ck, (contentionServes.byCk.get(ck) ?? 0) + 1);
        }
        if (serves.length === total) {
          drainStep = step;
        }
      }

      // release env/queue concurrency for serves whose hold has elapsed
      for (let i = inFlight.length - 1; i >= 0; i--) {
        const entry = inFlight[i]!;
        if (entry.servedAtStep + scenario.holdSteps <= step) {
          await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, entry.messageId, {
            skipDequeueProcessing: true,
          });
          inFlight.splice(i, 1);
        }
      }
    }

    return { serves, drainStep, contentionServes };
  } finally {
    await queue.quit();
  }
}

// Wait per message = serve step - arrival step, and arrival is step 0 for the
// whole pre-enqueued backlog, so the wait is just the serve step.
function meanWait(result: ScenarioResult, matches: (ck: string) => boolean): number {
  const waits = result.serves.filter((s) => matches(s.ck)).map((s) => s.step);
  expect(waits.length).toBeGreaterThan(0);
  return waits.reduce((a, b) => a + b, 0) / waits.length;
}

function firstServeStep(result: ScenarioResult, matches: (ck: string) => boolean): number {
  const first = result.serves.find((s) => matches(s.ck));
  expect(first).toBeDefined();
  return first!.step;
}

// No loss and no double-serve, in both runs.
function assertConservation(scenario: Scenario, on: ScenarioResult, off: ScenarioResult) {
  expect(on.serves.length).toBe(scenario.messages.length);
  expect(off.serves.length).toBe(scenario.messages.length);
  expect(new Set(on.serves.map((s) => s.messageId)).size).toBe(scenario.messages.length);
  expect(new Set(off.serves.map((s) => s.messageId)).size).toBe(scenario.messages.length);
}

function debugLog(name: string, data: Record<string, unknown>) {
  if (process.env.CK_FAIRNESS_DEBUG) {
    // the test reporter swallows console output, so append to a file instead
    appendFileSync(
      process.env.CK_FAIRNESS_DEBUG,
      `[ckVtimeFairness] ${name} ${JSON.stringify(data)}\n`
    );
  }
}

vi.setConfig({ testTimeout: 120_000 });

describe("CK virtual-time fairness on the real batched dequeue path", () => {
  // ckSkew (spike shape): one heavy key with a 120-message backlog on an old
  // shared head, 4 light keys with 10 messages each on later heads.
  //
  // Contention regime: env limit 1, hold 3. The batched dequeue serves at most
  // one message per variant per call, so at env limit 4 (the spike's driver
  // setting) a single heavy key cannot crowd out 4 light keys at all: both
  // flags serve every light key each round and the ON/OFF ratio sits near 1.
  // The head-age starvation the spike measured appears on this path when env
  // capacity serializes the calls (limit 1): flag OFF then always picks the
  // globally oldest head, which is heavy for its whole backlog.
  redisTest(
    "ckSkew: light keys stop waiting behind the heavy backlog",
    async ({ redisContainer }) => {
      const t0 = Date.now() - 500_000;
      const messages: ScenarioMessage[] = [];
      for (let i = 0; i < 120; i++) {
        messages.push({ runId: `heavy-${i}`, ck: "heavy", timestamp: t0 });
      }
      for (let i = 0; i < 10; i++) {
        for (let k = 0; k < 4; k++) {
          messages.push({
            runId: `light${k}-${i}`,
            ck: `light${k}`,
            timestamp: t0 + 10_000 + i * 4 + k,
          });
        }
      }
      const scenario: Scenario = {
        name: "ckSkew",
        messages,
        envConcurrencyLimit: 1,
        holdSteps: 3,
        maxSteps: 1_000,
      };

      const on = await runScenario(redisContainer, scenario, true);
      const off = await runScenario(redisContainer, scenario, false);

      assertConservation(scenario, on, off);

      const isLight = (ck: string) => ck.startsWith("light");
      const onWait = meanWait(on, isLight);
      const offWait = meanWait(off, isLight);
      debugLog("ckSkew", { onWait, offWait, ratio: onWait / offWait });

      // Heavy's wait may rise under the fair order; that is expected and not
      // asserted down.
      expect(onWait).toBeLessThanOrEqual(0.3 * offWait);
    }
  );

  // ckTrickle (spike shape): one bulk key with a 120-message backlog on an old
  // shared head, two trickle keys with 15 messages each on later heads. Same
  // serialized contention regime as ckSkew, same assertion.
  redisTest(
    "ckTrickle: trickle keys stop waiting behind the bulk backlog",
    async ({ redisContainer }) => {
      const t0 = Date.now() - 500_000;
      const messages: ScenarioMessage[] = [];
      for (let i = 0; i < 120; i++) {
        messages.push({ runId: `bulk-${i}`, ck: "bulk", timestamp: t0 });
      }
      for (let i = 0; i < 15; i++) {
        for (let k = 0; k < 2; k++) {
          messages.push({
            runId: `trickle${k}-${i}`,
            ck: `trickle${k}`,
            timestamp: t0 + 10_000 + i * 2 + k,
          });
        }
      }
      const scenario: Scenario = {
        name: "ckTrickle",
        messages,
        envConcurrencyLimit: 1,
        holdSteps: 3,
        maxSteps: 1_000,
      };

      const on = await runScenario(redisContainer, scenario, true);
      const off = await runScenario(redisContainer, scenario, false);

      assertConservation(scenario, on, off);

      const isTrickle = (ck: string) => ck.startsWith("trickle");
      const onWait = meanWait(on, isTrickle);
      const offWait = meanWait(off, isTrickle);
      debugLog("ckTrickle", { onWait, offWait, ratio: onWait / offWait });

      expect(onWait).toBeLessThanOrEqual(0.3 * offWait);
    }
  );

  // ckSybil (spike shape, the case per-key caps cannot fix): 20 attacker keys
  // with 8 messages each, all on older heads, and 1 light key with 10 newer
  // messages. 21 variants against a batch of 10 exercises the batched path
  // properly: flag OFF walks the age order and only reaches the light key when
  // the attackers are nearly drained; flag ON serves the light key from the
  // floor on its first fair round.
  redisTest("ckSybil: many attacker keys cannot starve a light key", async ({ redisContainer }) => {
    const t0 = Date.now() - 500_000;
    const messages: ScenarioMessage[] = [];
    for (let i = 0; i < 8; i++) {
      for (let k = 0; k < 20; k++) {
        const ck = `att${String(k).padStart(2, "0")}`;
        messages.push({ runId: `${ck}-${i}`, ck, timestamp: t0 + i * 20 + k });
      }
    }
    for (let i = 0; i < 10; i++) {
      messages.push({ runId: `light-${i}`, ck: "light", timestamp: t0 + 50_000 + i });
    }
    const scenario: Scenario = {
      name: "ckSybil",
      messages,
      envConcurrencyLimit: 25,
      holdSteps: 3,
      maxSteps: 300,
    };

    const on = await runScenario(redisContainer, scenario, true);
    const off = await runScenario(redisContainer, scenario, false);

    assertConservation(scenario, on, off);

    const isLight = (ck: string) => ck === "light";

    // Reachability at the floor: enqueue registered the light key at the
    // floor, so it is served within the first 3 steps even though 20 attacker
    // variants sit ahead of it in age order.
    const onFirstServe = firstServeStep(on, isLight);
    expect(onFirstServe).toBeLessThanOrEqual(2);

    const onWait = meanWait(on, isLight);
    const offWait = meanWait(off, isLight);

    // Contention-window share (directional, per the spike's confounding
    // caveat; the wait ratio is the headline): over the steps where >= 2 keys
    // had queued backlog, light's served fraction is at least half its fair
    // share of 1/21.
    const lightContentionServes = on.contentionServes.byCk.get("light") ?? 0;
    const lightShare = lightContentionServes / on.contentionServes.total;

    debugLog("ckSybil", {
      onWait,
      offWait,
      ratio: onWait / offWait,
      onFirstServe,
      lightShare,
      fairShare: 1 / 21,
    });

    expect(onWait).toBeLessThanOrEqual(0.7 * offWait);
    expect(lightShare).toBeGreaterThanOrEqual(0.5 * (1 / 21));
  });

  // ckBalanced (spike shape, no-harm check): 4 symmetric keys with 25 messages
  // each. The fair order must not make the symmetric case worse.
  redisTest(
    "ckBalanced: fair order does not hurt the symmetric case",
    async ({ redisContainer }) => {
      const t0 = Date.now() - 500_000;
      const cks = ["bal0", "bal1", "bal2", "bal3"];
      const messages: ScenarioMessage[] = [];
      for (let i = 0; i < 25; i++) {
        for (let k = 0; k < cks.length; k++) {
          messages.push({
            runId: `${cks[k]}-${i}`,
            ck: cks[k]!,
            timestamp: t0 + i * 4 + k,
          });
        }
      }
      const scenario: Scenario = {
        name: "ckBalanced",
        messages,
        envConcurrencyLimit: 4,
        holdSteps: 3,
        maxSteps: 500,
      };

      const on = await runScenario(redisContainer, scenario, true);
      const off = await runScenario(redisContainer, scenario, false);

      assertConservation(scenario, on, off);

      const maxPerKeyMeanWait = (result: ScenarioResult) =>
        Math.max(...cks.map((ck) => meanWait(result, (c) => c === ck)));

      const onMax = maxPerKeyMeanWait(on);
      const offMax = maxPerKeyMeanWait(off);
      debugLog("ckBalanced", { onMax, offMax, ratio: onMax / offMax });

      expect(onMax).toBeLessThanOrEqual(1.25 * offMax);
    }
  );

  // ckHeavyIdle (spike shape, work conservation): a single key with 60
  // messages and nothing else contending. Any extra step to drain under the
  // fair order is a work-conservation bug, so the step counts must be exactly
  // equal.
  redisTest(
    "ckHeavyIdle: a lone key drains in exactly the same steps",
    async ({ redisContainer }) => {
      const t0 = Date.now() - 500_000;
      const messages: ScenarioMessage[] = [];
      for (let i = 0; i < 60; i++) {
        messages.push({ runId: `solo-${i}`, ck: "solo", timestamp: t0 + i });
      }
      const scenario: Scenario = {
        name: "ckHeavyIdle",
        messages,
        envConcurrencyLimit: 25,
        holdSteps: 3,
        maxSteps: 300,
      };

      const on = await runScenario(redisContainer, scenario, true);
      const off = await runScenario(redisContainer, scenario, false);

      assertConservation(scenario, on, off);

      debugLog("ckHeavyIdle", { onDrainStep: on.drainStep, offDrainStep: off.drainStep });

      expect(on.drainStep).toBeGreaterThanOrEqual(0);
      expect(on.drainStep).toBe(off.drainStep);
    }
  );
});
