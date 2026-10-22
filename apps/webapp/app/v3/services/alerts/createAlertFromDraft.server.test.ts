import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

import { alertParamsSchema } from "@internal/alert-contracts";
import type { PrismaClient } from "@trigger.dev/database";
import { startAlertsPostgres } from "../../../../test/helpers/alertTables";
import { redisTest } from "@internal/testcontainers";
import { AlertDetailPresenter } from "../../../presenters/v3/AlertDetailPresenter.server";
import {
  AbsenceWindowTooShortError,
  createAlertFromDraft,
  IncompatibleAlertKindError,
  IncompleteChatNotifierError,
  InvalidConditionParamsError,
  InvalidScopeForCapabilityError,
  InvalidNotifierError,
  NoNotifiersError,
  resolveAlertDraftPrefill,
  UnknownCapabilityError,
  type AlertDraftScope,
} from "./createAlertFromDraft.server";
import { createWorker, depsFor } from "./alertLifecycleTestWorker";
import { alertEvaluationJobId } from "./engine/evaluateAlertJob.server";

const noopDeps = { enqueue: async () => {}, ack: async () => {} };

let pg: Awaited<ReturnType<typeof startAlertsPostgres>>;
let db: PrismaClient;

beforeAll(async () => {
  pg = await startAlertsPostgres();
  db = pg.prisma;
}, 120_000);

afterAll(async () => {
  await pg?.stop();
});

const BASE = {
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
  createdBy: "user_1",
  notifiers: [{ type: "channel" as const, channelId: "chan_1" }],
};

describe("createAlertFromDraft", () => {
  redisTest("creates a queue.depth threshold alert", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const deps = depsFor(worker);
    const alert = await createAlertFromDraft(
      db,
      {
        ...BASE,
        capabilityKey: "queue.depth",
        scope: { type: "queue", queue: "worker-1" },
        condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
      },
      deps
    );

    expect(alert.capabilityKey).toBe("queue.depth");
    expect(alert.params).toEqual({
      environmentId: "env_1",
      scope: { type: "queue", queue: "worker-1" },
    });
    expect(alert.condition).toEqual({
      kind: "threshold",
      operator: ">",
      value: 100,
      windowSec: 300,
    });
    expect(alert.notifiers).toEqual([{ type: "channel", channelId: "chan_1" }]);
    expect(await worker.getJob(alertEvaluationJobId(alert.id))).toBeTruthy();
    await worker.stop();
  });

  it("rejects an empty notifiers list (mutation: length check removed)", async () => {
    await expect(
      createAlertFromDraft(db, {
        ...BASE,
        capabilityKey: "queue.depth",
        scope: { type: "all" },
        condition: { kind: "threshold", operator: ">", value: 5, windowSec: 60 },
        notifiers: [],
      })
    ).rejects.toThrow(NoNotifiersError);
  });

  it("rejects a malformed channel notifier ref", async () => {
    await expect(
      createAlertFromDraft(db, {
        ...BASE,
        capabilityKey: "queue.depth",
        scope: { type: "all" },
        condition: { kind: "threshold", operator: ">", value: 5, windowSec: 60 },
        notifiers: [{ type: "channel" } as unknown as (typeof BASE)["notifiers"][number]],
      })
    ).rejects.toThrow(InvalidNotifierError);
  });

  it("rejects an incompatible kind", async () => {
    await expect(
      createAlertFromDraft(db, {
        ...BASE,
        capabilityKey: "queue.depth",
        scope: { type: "all" },
        condition: { kind: "occurrence" },
      })
    ).rejects.toThrow(IncompatibleAlertKindError);
  });

  it("rejects an unknown capability", async () => {
    await expect(
      createAlertFromDraft(db, {
        ...BASE,
        capabilityKey: "not.a.capability",
        scope: { type: "all" },
        condition: { kind: "occurrence" },
      })
    ).rejects.toThrow(UnknownCapabilityError);
  });

  it("rejects absence below the min window", async () => {
    await expect(
      createAlertFromDraft(db, {
        ...BASE,
        capabilityKey: "runs.created",
        scope: { type: "all" },
        condition: { kind: "absence", quietWindowSec: 600 },
      })
    ).rejects.toThrow(AbsenceWindowTooShortError);
  });

  it("accepts absence at or above the min window", async () => {
    const alert = await createAlertFromDraft(
      db,
      {
        ...BASE,
        capabilityKey: "runs.created",
        scope: { type: "all" },
        condition: { kind: "absence", quietWindowSec: 1800 },
      },
      noopDeps
    );

    expect(alert.capabilityKey).toBe("runs.created");
  });

  it("rejects a task scope for a queue capability", async () => {
    await expect(
      createAlertFromDraft(db, {
        ...BASE,
        capabilityKey: "queue.depth",
        scope: { type: "task", taskIdentifier: "my-task" },
        condition: { kind: "threshold", operator: ">", value: 5, windowSec: 300 },
      })
    ).rejects.toThrow(InvalidScopeForCapabilityError);
  });

  it("rejects a negative condition window", async () => {
    await expect(
      createAlertFromDraft(db, {
        ...BASE,
        capabilityKey: "queue.depth",
        scope: { type: "all" },
        condition: { kind: "threshold", operator: ">", value: 5, windowSec: -300 },
      })
    ).rejects.toThrow();
  });

  it("rejects a chat notifier with no conversation (mutation: IncompleteChatNotifierError guard removed)", async () => {
    await expect(
      createAlertFromDraft(db, {
        ...BASE,
        capabilityKey: "queue.depth",
        scope: { type: "all" },
        condition: { kind: "threshold", operator: ">", value: 5, windowSec: 300 },
        notifiers: [{ type: "chat" }],
      })
    ).rejects.toThrow(IncompleteChatNotifierError);
  });

  it("rejects a chat notifier with only a user and creates no alert (mutation: chatId requirement removed)", async () => {
    await expect(
      createAlertFromDraft(
        db,
        {
          ...BASE,
          capabilityKey: "queue.depth",
          scope: { type: "all" },
          condition: { kind: "threshold", operator: ">", value: 5, windowSec: 300 },
          notifiers: [{ type: "chat", userId: "user_1" }],
        },
        noopDeps
      )
    ).rejects.toThrow(IncompleteChatNotifierError);
  });

  it("rejects a chat notifier with whitespace-only conversation/user ids (mutation: trim removed)", async () => {
    await expect(
      createAlertFromDraft(db, {
        ...BASE,
        capabilityKey: "queue.depth",
        scope: { type: "all" },
        condition: { kind: "threshold", operator: ">", value: 5, windowSec: 300 },
        notifiers: [{ type: "chat", chatId: "   ", userId: "  " }],
      })
    ).rejects.toThrow(IncompleteChatNotifierError);
  });

  const SCOPE_VARIANTS: AlertDraftScope[] = [
    { type: "queue", queue: "worker-1" },
    { type: "queuePattern", pattern: "worker-*" },
    { type: "task", taskIdentifier: "my-task" },
    { type: "all" },
  ];

  it.each(SCOPE_VARIANTS)(
    "stores params matching alertParamsSchema for scope %o",
    async (scope) => {
      const capabilityKey = scope.type === "task" ? "runs.volume" : "queue.depth";
      const alert = await createAlertFromDraft(
        db,
        {
          ...BASE,
          capabilityKey,
          scope,
          condition: { kind: "threshold", operator: ">", value: 5, windowSec: 300 },
        },
        noopDeps
      );

      expect(() => alertParamsSchema.parse(alert.params)).not.toThrow();
      expect(alertParamsSchema.parse(alert.params)).toEqual({
        environmentId: BASE.environmentId,
        scope,
      });
    }
  );

  it("loads a page-created alert on the detail presenter without throwing", async () => {
    const alert = await createAlertFromDraft(
      db,
      {
        ...BASE,
        capabilityKey: "queue.depth",
        scope: { type: "queue", queue: "worker-1" },
        condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
      },
      noopDeps
    );

    const presenter = new AlertDetailPresenter(
      db,
      undefined,
      async () => ({ environmentType: null, channels: new Map() }),
      async () => null,
      async () => null,
      {
        evaluateBinding: async () => ({
          result: { kind: "stateful", outcome: "unavailable", facts: {} },
        }),
      }
    );

    const detail = await presenter.call({
      id: alert.id,
      projectId: alert.projectId,
      environmentId: alert.environmentId,
    });

    expect(detail?.scope).toEqual({ type: "queue", queue: "worker-1" });
  });
});

describe("resolveAlertDraftPrefill", () => {
  it("returns capability and scope from query params", () => {
    const prefill = resolveAlertDraftPrefill({
      capability: "queue.depth",
      scope: "queue",
      scopeValue: "worker-1",
    });

    expect(prefill).toEqual({
      capabilityKey: "queue.depth",
      scope: { type: "queue", queue: "worker-1" },
    });
  });

  it("resolves an 'all' scope without a scope value", () => {
    const prefill = resolveAlertDraftPrefill({ capability: "runs.volume", scope: "all" });

    expect(prefill).toEqual({ capabilityKey: "runs.volume", scope: { type: "all" } });
  });

  it("returns just the capability when no scope is given", () => {
    const prefill = resolveAlertDraftPrefill({ capability: "queue.depth" });

    expect(prefill).toEqual({ capabilityKey: "queue.depth" });
  });

  it("returns an empty prefill when nothing is given", () => {
    expect(resolveAlertDraftPrefill({})).toEqual({ capabilityKey: undefined });
  });
});

describe("state condition params validation", () => {
  it("fails when the create path accepts an unknown param key", async () => {
    await expect(
      createAlertFromDraft(db, {
        ...BASE,
        capabilityKey: "health.all",
        scope: { type: "all" },
        condition: {
          kind: "state",
          stateKey: "degraded",
          params: { unknownParam: 42 },
        },
      })
    ).rejects.toThrow(InvalidConditionParamsError);
  });

  it("rejects params for a capability without declared params", async () => {
    await expect(
      createAlertFromDraft(db, {
        ...BASE,
        capabilityKey: "queue.stalled",
        scope: { type: "all" },
        condition: {
          kind: "state",
          stateKey: "stalled",
          params: { bogus: 42 },
        },
      })
    ).rejects.toThrow(InvalidConditionParamsError);
  });

  it("fails when the create path accepts a value above max", async () => {
    await expect(
      createAlertFromDraft(db, {
        ...BASE,
        capabilityKey: "health.all",
        scope: { type: "all" },
        condition: {
          kind: "state",
          stateKey: "degraded",
          params: { aboveMax: 999999999 },
        },
      })
    ).rejects.toThrow(InvalidConditionParamsError);
  });
});
