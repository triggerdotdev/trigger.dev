import {
  claimWatchDelivery,
  claimWatchTick,
  createDashboardAgentDb,
  getWatch,
  markWatchDelivered,
  recordWatchCheck,
  releaseWatchDelivery,
  transitionWatchCondition,
  type DashboardAgentDbClient,
  type Watch,
} from "@internal/dashboard-agent-db";
import { sessions } from "@trigger.dev/sdk";
import type { WatchWakeAction } from "./dashboard-agent";
import type { WatchTickStore } from "./watch-delivery";
import type { WatchBatchCheckResponse, WatchBatchTickPayload } from "./watch-batch";

/** What the two watch tasks plug into the lifecycle: the db, the wake append, the callbacks. */

/** The url the watch, sweep and retention tasks connect with, so an unwired deployment can skip instead of throw. */
export function watchConnectionString(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // `||`, so an empty dedicated url falls back instead of connecting to "".
  return env.DASHBOARD_AGENT_DATABASE_URL || env.DATABASE_URL;
}

// One connection pool per worker process.
let dbClient: DashboardAgentDbClient | undefined;
export function getWatchDb(): DashboardAgentDbClient {
  if (!dbClient) {
    const connectionString = watchConnectionString();
    if (!connectionString) {
      throw new Error(
        "DASHBOARD_AGENT_DATABASE_URL (or DATABASE_URL) must be set for the watch and sweep tasks"
      );
    }
    dbClient = createDashboardAgentDb(connectionString, { max: 2 });
  }
  return dbClient;
}

export function watchStore(db: DashboardAgentDbClient["db"]): WatchTickStore {
  return {
    getWatch: (params) => getWatch(db, params),
    claimWatchTick: (params) => claimWatchTick(db, params),
    transitionWatchCondition: (params) => transitionWatchCondition(db, params),
    claimWatchDelivery: (params) => claimWatchDelivery(db, params),
    releaseWatchDelivery: (params) => releaseWatchDelivery(db, params),
    markWatchDelivered: (params) => markWatchDelivered(db, params),
    recordWatchCheck: (params) => recordWatchCheck(db, params),
  };
}

export type WatchCallbackTarget = { apiOrigin: string; watchId: string; token: string };

// No retry loop: the endpoint dedupes on the watch, and losing an alert beats losing
// the wake.
export async function postFired(target: WatchCallbackTarget): Promise<void> {
  await postWatchCallback(target, "fired");
}

// Says only that the wake is delivered; the endpoint decides whether the outcome is
// one the consent covers.
export async function postInvestigate(target: WatchCallbackTarget): Promise<void> {
  await postWatchCallback(target, "investigate");
}

async function postWatchCallback(
  target: WatchCallbackTarget,
  path: "fired" | "investigate"
): Promise<void> {
  const origin = target.apiOrigin.replace(/\/$/, "");
  const response = await fetch(
    `${origin}/api/v1/dashboard-agent/watches/${encodeURIComponent(target.watchId)}/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
    }
  );

  if (!response.ok) {
    throw new Error(`the ${path} callback returned ${response.status}`);
  }
}

export async function postBatchCheck(
  payload: WatchBatchTickPayload
): Promise<WatchBatchCheckResponse> {
  const origin = payload.apiOrigin.replace(/\/$/, "");
  const response = await fetch(`${origin}/api/v1/dashboard-agent/watches/batch-check`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${payload.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      environmentId: payload.environmentId,
      cadenceMinutes: payload.cadenceMinutes,
      epoch: payload.epoch,
      tick: payload.tick,
    }),
  });

  const body = (await response.json().catch(() => undefined)) as
    | (WatchBatchCheckResponse & { error?: string })
    | undefined;

  if (!response.ok) {
    // A throw, not an empty batch: rescheduling as if nothing was due would skip the
    // whole group.
    throw new Error(body?.error ?? `the batch check returned ${response.status}`);
  }

  return body ?? {};
}

/**
 * Appends a `trigger: "action"` record, which fires `onAction` and nothing else.
 * `metadata` is the agent's `clientData` and carries no delegated token.
 */
export async function appendWakeToSession(args: {
  chatId: string;
  action: WatchWakeAction;
  watch: Watch;
}): Promise<void> {
  const metadata = {
    userId: args.watch.userId,
    organizationId: args.watch.organizationId,
    projectId: args.watch.projectId,
    environmentId: args.watch.environmentId,
    // The external ref a consented investigation is scoped by.
    ...(args.watch.projectRef ? { projectRef: args.watch.projectRef } : {}),
  };

  const send = () =>
    sessions.open(args.chatId).in.send({
      kind: "message",
      payload: {
        chatId: args.chatId,
        trigger: "action",
        action: args.action,
        metadata,
      },
    });

  try {
    await send();
  } catch (error) {
    // A chat born from the configuration card has no session yet, so create it
    // (idempotent on externalId) and retry once.
    if (!isSessionNotFound(error)) throw error;
    await sessions.start({
      type: "chat.agent",
      externalId: args.chatId,
      taskIdentifier: "dashboard-agent",
      triggerConfig: {
        basePayload: { trigger: "preload", chatId: args.chatId, metadata },
      },
    });
    await send();
  }
}

function isSessionNotFound(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const e = error as { name?: string; status?: number };
  return e.name === "TriggerApiError" && e.status === 404;
}
