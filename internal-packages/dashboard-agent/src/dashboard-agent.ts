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
import { locals, logger, tasks } from "@trigger.dev/sdk";
import {
  createProviderRegistry,
  generateText,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
} from "ai";
import { z } from "zod";
import type { EvalTurnPayload, evalTurn } from "./eval-turn";
import { systemPrompt, titlePrompt } from "./prompts";
import { buildDashboardAgentTools } from "./tools";

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

// The persistence the agent does against its own datastore, behind an interface
// so it can be injected. Production lazily builds one over the env-configured
// Drizzle client (below); unit tests inject a fake via `locals` (the DI pattern
// from the chat.agent testing guide) so the agent never needs a real database.
export interface DashboardAgentStore {
  ensureChat(args: Parameters<typeof ensureChat>[1]): Promise<unknown>;
  persistMessages(args: Parameters<typeof persistMessages>[1]): Promise<unknown>;
  persistTurn(args: Parameters<typeof persistTurn>[1]): Promise<unknown>;
  setChatTitleIfDefault(args: Parameters<typeof setChatTitleIfDefault>[1]): Promise<unknown>;
}

export const dashboardAgentStoreKey = locals.create<DashboardAgentStore>("dashboard-agent.store");

// Returns the injected store if a test seeded one, otherwise lazily builds the
// production store over the env-configured Drizzle client and caches it.
function getStore(): DashboardAgentStore {
  const injected = locals.get(dashboardAgentStoreKey);
  if (injected) return injected;
  const { db } = getDb();
  return locals.set(dashboardAgentStoreKey, {
    ensureChat: (args) => ensureChat(db, args),
    persistMessages: (args) => persistMessages(db, args),
    persistTurn: (args) => persistTurn(db, args),
    setChatTitleIfDefault: (args) => setChatTitleIfDefault(db, args),
  });
}

// Optional language-model override. Production leaves this unset and resolves the
// model from the managed prompt through the provider registry; unit tests inject
// a mock model here so `run()` and title generation never reach a provider.
export const dashboardAgentModelKey = locals.create<LanguageModel>("dashboard-agent.model");

// Optional tool-set override. Production leaves this unset and builds the real
// tools per turn; tests and evals inject a fixture tool set (real schemas,
// stubbed executes) so the model's tool choice can be observed and its answers
// judged without a live API.
export const dashboardAgentToolsKey = locals.create<ToolSet>("dashboard-agent.tools");

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

// Pair this turn's tool-calls with their results (the ground truth the eval
// judge checks the answer against). Works off the model-format messages.
function extractToolActivity(
  messages: ModelMessage[]
): Array<{ toolName: string; input?: unknown; output?: unknown }> {
  const byId = new Map<string, { toolName: string; input?: unknown; output?: unknown }>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Array<{
      type: string;
      toolCallId?: string;
      toolName?: string;
      input?: unknown;
      output?: unknown;
    }>) {
      if (part.type === "tool-call" && part.toolCallId) {
        byId.set(part.toolCallId, { toolName: String(part.toolName ?? ""), input: part.input });
      } else if (part.type === "tool-result" && part.toolCallId) {
        const existing = byId.get(part.toolCallId);
        if (existing) existing.output = part.output;
      }
    }
  }
  return [...byId.values()];
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
  store: DashboardAgentStore,
  chatId: string,
  uiMessages: UIMessage[]
): Promise<void> {
  const firstUserMessage = uiMessages.find((message) => message.role === "user");
  const userText = firstUserMessage ? extractText(firstUserMessage) : "";
  if (!userText) return;

  const resolved = await titlePrompt.resolve({});
  const { text } = await generateText({
    model:
      locals.get(dashboardAgentModelKey) ??
      registry.languageModel((resolved.model ?? "anthropic:claude-haiku-4-5") as `anthropic:${string}`),
    system: resolved.text,
    prompt: userText,
    ...resolved.toAISDKTelemetry(),
  });

  const title = cleanTitle(text);
  if (title) {
    await store.setChatTitleIfDefault({ chatId, title });
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
  // Injected server-side by the `in` proxy on each turn (never sent from the
  // browser): a short-lived read-only delegated token for the user, the API
  // origin to call back to, and the current project ref + env its tools read.
  userActorToken: z.string().optional(),
  apiOrigin: z.string().optional(),
  projectRef: z.string().optional(),
  environmentName: z.string().optional(),
});

export const dashboardAgent = chat.agent({
  id: "dashboard-agent",
  clientDataSchema,
  // Latency levers come next (Head Start, prompt caching, AI Prompts). Scaffold
  // keeps a short idle window so suspended runs release their DB pool.
  idleTimeoutInSeconds: 60,

  // Read-only tools, rebuilt per turn from the delegated token the `in` proxy
  // injects. Declaring them here (not just inside run) lets the SDK re-apply
  // each tool's output conversion when it replays prior-turn history.
  tools: async ({ clientData }) =>
    locals.get(dashboardAgentToolsKey) ?? buildDashboardAgentTools(clientData ?? {}),

  onBoot: async () => {
    // Establish the store (and, in production, its connection pool) once.
    getStore();
  },

  onChatStart: async ({ chatId, clientData }) => {
    await getStore().ensureChat({
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
    await getStore().persistMessages({ chatId, messages: uiMessages });

    // Load the dashboard-managed system prompt for this turn. Set every turn so
    // continuation runs (which skip onChatStart) still get it; the resolve is
    // cached per process. The Anthropic cache breakpoint on the system block
    // carries through toStreamTextOptions() and survives suspend/resume.
    chat.prompt.set(await getSystemPrompt(), {
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  },

  onTurnComplete: async ({
    chatId,
    turn,
    uiMessages,
    newMessages,
    responseMessage,
    clientData,
    chatAccessToken,
    lastEventId,
    runId,
  }) => {
    // Persist the finalized transcript + refreshed session state in one
    // transaction so a refresh on the next page load reads both consistently.
    const store = getStore();
    await store.persistTurn({
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
      chat.defer(generateAndSaveTitle(store, chatId, uiMessages));
    }

    // Runtime eval: score this turn in a SEPARATE, idempotency-keyed task so it
    // never blocks or bills the agent run. Best-effort — enqueue failures must
    // not break the turn. Every turn for now (internal, low volume); add a
    // sample rate here when this scales.
    if (clientData?.organizationId && clientData?.userId && responseMessage) {
      try {
        const resolved = await getSystemPrompt();
        // The current turn's question. On a Head Start turn it arrives in the
        // boot payload (not in newUIMessages), so take the latest user message
        // from the full transcript, which holds for normal turns too.
        const userMessage = [...uiMessages].reverse().find((m) => m.role === "user");
        await tasks.trigger<typeof evalTurn>(
          "dashboard-agent-eval-turn",
          {
            chatId,
            turn,
            agentRunId: runId,
            organizationId: clientData.organizationId,
            userId: clientData.userId,
            projectRef: clientData.projectRef,
            environment: clientData.environmentName,
            currentPage: clientData.currentPage,
            model: resolved.model,
            promptSlug: resolved.promptId,
            promptVersion: resolved.version,
            userText: userMessage ? extractText(userMessage) : "",
            assistantText: extractText(responseMessage),
            toolActivity: extractToolActivity(newMessages),
          } satisfies EvalTurnPayload,
          { idempotencyKey: `eval:${chatId}:${turn}` }
        );
      } catch (error) {
        logger.error("Failed to enqueue dashboard-agent turn eval", { error });
      }
    }
  },

  // Roll an Anthropic cache breakpoint onto the last message every turn so the
  // growing conversation prefix is cached and read back cheaply. Composes with
  // the system-block breakpoint above. This is the canonical prompt-caching
  // pattern; chat.agent keeps the Head Start handover's tool-approval tail
  // intact across this hook, so it's safe on a resume turn.
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
  run: async ({ messages, signal, tools }) => {
    const resolved = chat.prompt();
    return streamText({
      ...chat.toStreamTextOptions({ tools }),
      // Tests inject a mock model via locals; production resolves the managed
      // prompt's model through the provider registry.
      model:
        locals.get(dashboardAgentModelKey) ??
        registry.languageModel((resolved.model ?? "anthropic:claude-sonnet-4-6") as `anthropic:${string}`),
      messages,
      abortSignal: signal,
      // toStreamTextOptions() defaults to a single step; override so the model
      // can call a tool and then answer from its result in the same turn.
      stopWhen: stepCountIs(10),
    });
  },
});
