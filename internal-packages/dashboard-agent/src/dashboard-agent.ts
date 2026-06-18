import { anthropic } from "@ai-sdk/anthropic";
import {
  createDashboardAgentDb,
  ensureChat,
  persistMessages,
  persistTurn,
  setChatTitleIfDefault,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { chat } from "@trigger.dev/sdk/ai";
import { createProviderRegistry, generateText, streamText, type UIMessage } from "ai";
import { z } from "zod";
import { systemPrompt, titlePrompt } from "./prompts";

/**
 * The in-dashboard agent, built on chat.agent and deployed as an internal task
 * by the webapp. This is the launch-week dogfood: we run our own product on the
 * primitive we ship.
 *
 * No tools yet: it answers from a dashboard-managed system prompt (Anthropic,
 * resolved via the provider registry) with prompt caching, persists the
 * conversation to the agent's own datastore (NOT the main DB — the agent has no
 * access to that), and generates the chat title in the background. Runtime
 * history is owned by chat.agent's built-in object-store snapshot; the rows we
 * write here are the display read-model the dashboard's History tab and panel
 * render from.
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

// Resolves the `"provider:model-id"` strings on our managed prompts to AI SDK
// models. Anthropic only for now; add another @ai-sdk/* provider here to let
// the dashboard pick its models on a prompt.
const registry = createProviderRegistry({ anthropic });

// The system prompt is dashboard-managed (text + model + config). Resolving it
// is an API call, so cache it per worker process — workers are short-lived
// (idleTimeoutInSeconds), so a dashboard edit lands within a recycle.
let cachedSystemPrompt: Awaited<ReturnType<typeof systemPrompt.resolve>> | undefined;
async function getSystemPrompt() {
  cachedSystemPrompt ??= await systemPrompt.resolve({});
  return cachedSystemPrompt;
}

function extractText(message: UIMessage): string {
  return (message.parts ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .trim();
}

function cleanTitle(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();
}

// Generate a short title from the first user message using the cheaper title
// model, then write it only if the chat still has the default title. Runs in
// the background (chat.defer) so it never blocks the response.
async function generateAndSaveTitle(
  db: Parameters<typeof setChatTitleIfDefault>[0],
  chatId: string,
  uiMessages: UIMessage[]
): Promise<void> {
  const firstUserMessage = uiMessages.find((message) => message.role === "user");
  const userText = firstUserMessage ? extractText(firstUserMessage) : "";
  if (!userText) return;

  const resolved = await titlePrompt.resolve({});
  const { text } = await generateText({
    model: registry.languageModel(
      (resolved.model ?? "anthropic:claude-haiku-4-5") as `anthropic:${string}`
    ),
    system: resolved.text,
    prompt: userText,
    ...resolved.toAISDKTelemetry(),
  });

  const title = cleanTitle(text);
  if (title) {
    await setChatTitleIfDefault(db, { chatId, title });
  }
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

    // Load the dashboard-managed system prompt for this turn. Set every turn so
    // continuation runs (which skip onChatStart) still get it; the resolve is
    // cached per process. The Anthropic cache breakpoint on the system block
    // carries through toStreamTextOptions() and survives suspend/resume.
    chat.prompt.set(await getSystemPrompt(), {
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
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

    // First exchange: generate a title with the cheaper title model in the
    // background. Deferred from onTurnComplete, so it runs during the idle wait
    // and never blocks the response; the write is conditional (default title).
    if (uiMessages.length <= 2) {
      chat.defer(generateAndSaveTitle(db, chatId, uiMessages));
    }
  },

  // Roll an Anthropic cache breakpoint onto the last message every turn so the
  // growing conversation prefix is cached and read back cheaply. Runs on every
  // prompt-assembly path (turns + compaction), so the breakpoint always lands
  // on the real last message. Composes with the system-block breakpoint above.
  prepareMessages: ({ messages }) => {
    if (messages.length === 0) return messages;
    const last = messages[messages.length - 1];
    return [
      ...messages.slice(0, -1),
      {
        ...last,
        providerOptions: {
          ...last.providerOptions,
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      },
    ];
  },

  // System prompt + model come from the managed prompt (set in onTurnStart),
  // so they're dashboard-editable. toStreamTextOptions() supplies the system
  // text (with its cache breakpoint), config, telemetry, and prepareStep
  // wiring; the model string is resolved through the registry here so
  // streamText keeps a typed model.
  run: async ({ messages, signal }) => {
    const resolved = chat.prompt();
    return streamText({
      ...chat.toStreamTextOptions(),
      model: registry.languageModel(
        (resolved.model ?? "anthropic:claude-sonnet-4-6") as `anthropic:${string}`
      ),
      messages,
      abortSignal: signal,
    });
  },
});
