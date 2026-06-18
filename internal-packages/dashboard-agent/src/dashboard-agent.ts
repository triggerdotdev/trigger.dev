import { openai } from "@ai-sdk/openai";
import {
  createDashboardAgentDb,
  ensureChat,
  persistMessages,
  persistTurn,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { chat } from "@trigger.dev/sdk/ai";
import { streamText } from "ai";
import { z } from "zod";

/**
 * The in-dashboard agent, built on chat.agent and deployed as an internal task
 * by the webapp. This is the launch-week dogfood: we run our own product on the
 * primitive we ship.
 *
 * SCAFFOLD: no tools yet. It persists the conversation to the agent's own
 * datastore (NOT the main DB — the agent has no access to that) and streams a
 * placeholder model reply. Runtime history is owned by chat.agent's built-in
 * object-store snapshot; the rows we write here are the display read-model the
 * dashboard's History tab and panel render from.
 */

// One connection pool per worker process. onBoot fires on every fresh worker
// (initial, preloaded, and continuation runs), so the pool is established there
// and reused across turns within the run.
let dbClient: DashboardAgentDbClient | undefined;

function getDb(): DashboardAgentDbClient {
  if (!dbClient) {
    const connectionString =
      process.env.DASHBOARD_AGENT_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DASHBOARD_AGENT_DATABASE_URL (or DATABASE_URL) must be set for the dashboard agent"
      );
    }
    // Small client pool — the agent runs in many short-lived containers and the
    // PlanetScale pooler does the real pooling.
    dbClient = createDashboardAgentDb(connectionString, { max: 2 });
  }
  return dbClient;
}

// A chat belongs to an org + user. The current project/env (and the page) are
// per-turn context for the agent, not chat identity — one conversation can span
// several projects/envs.
const clientDataSchema = z.object({
  userId: z.string(),
  organizationId: z.string(),
  projectId: z.string().optional(),
  environmentId: z.string().optional(),
  currentPage: z.string().optional(),
});

export const dashboardAgent = chat.agent({
  id: "dashboard-agent",
  clientDataSchema,
  // Latency levers come next (Head Start, prompt caching, AI Prompts). Scaffold
  // keeps a short idle window so suspended runs release their DB pool.
  idleTimeoutInSeconds: 60,

  onBoot: async () => {
    // Establish the per-process connection pool once.
    getDb();
  },

  onChatStart: async ({ chatId, clientData }) => {
    const { db } = getDb();
    await ensureChat(db, {
      id: chatId,
      organizationId: clientData.organizationId,
      userId: clientData.userId,
      metadata: {
        context: {
          projectId: clientData.projectId,
          environmentId: clientData.environmentId,
          currentPage: clientData.currentPage,
        },
      },
    });
  },

  onTurnStart: async ({ chatId, uiMessages }) => {
    // Make the user's message durable in the display copy before the model
    // starts streaming. Awaited, never chat.defer — a mid-stream refresh must
    // not read an empty transcript.
    const { db } = getDb();
    await persistMessages(db, { chatId, messages: uiMessages });
  },

  onTurnComplete: async ({ chatId, uiMessages, chatAccessToken, lastEventId, runId }) => {
    // Persist the finalized transcript + refreshed session state in one
    // transaction so a refresh on the next page load reads both consistently.
    const { db } = getDb();
    await persistTurn(db, {
      chatId,
      messages: uiMessages,
      session: {
        publicAccessToken: chatAccessToken,
        lastEventId,
        runId,
      },
    });
  },

  run: async ({ messages, signal }) => {
    return streamText({
      model: openai("gpt-4o"),
      system:
        "You are the Trigger.dev dashboard agent. This is an early scaffold — you do not have tools or access to the user's data yet. Answer concisely and tell the user when something is not yet supported.",
      messages,
      abortSignal: signal,
    });
  },
});
