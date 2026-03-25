import { chat, type ChatTaskWirePayload } from "@trigger.dev/sdk/ai";
import { logger, task, prompts } from "@trigger.dev/sdk";
import { streamText, generateText, tool, dynamicTool, stepCountIs, generateId, createProviderRegistry } from "ai";
import type { LanguageModel, LanguageModelUsage, Tool as AITool, UIMessage } from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import os from "node:os";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../lib/generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

import TurndownService from "turndown";
import { DEFAULT_MODEL, REASONING_MODELS } from "@/lib/models";

const turndown = new TurndownService();
const COMPACT_AFTER_TOKENS = Number(process.env.COMPACT_AFTER_TOKENS) || 80_000;

const registry = createProviderRegistry({ openai, anthropic });

const compactionPrompt = prompts.define({
  id: "ai-chat-compaction",
  model: "openai:gpt-4o-mini",
  content: `You are a conversation compactor. You will receive a transcript of a multi-turn conversation between a user and an assistant.

Produce a concise summary that captures:
- The topics discussed and questions asked
- Any key facts, answers, or decisions reached
- Important context needed to continue the conversation naturally

Write in third person (e.g. "The user asked about..." / "The assistant explained...").
Keep it under 300 words. Do not include greetings or filler.`,
});

const systemPrompt = prompts.define({
  id: "ai-chat-system",
  model: "openai:gpt-4o",
  config: { temperature: 0.7 },
  variables: z.object({ name: z.string(), plan: z.string() }),
  content: `You are a helpful AI assistant for {{name}} on the {{plan}} plan.

## Guidelines
- Be concise and friendly. Prefer short, direct answers unless the user asks for detail.
- When using tools, explain what you're doing briefly before invoking them.
- If you don't know something, say so — don't make things up.

## Capabilities
You can inspect the execution environment, fetch web pages, and perform multi-URL deep research.
When the user asks you to research a topic, use the deep research tool with relevant URLs.

## Tone
- Match the user's formality level. If they're casual, be casual back.
- Use markdown formatting for code blocks, lists, and structured output.
- Keep responses under a few paragraphs unless the user asks for more.`,
});

const MODELS: Record<string, () => LanguageModel> = {
  "gpt-4o-mini": () => openai("gpt-4o-mini"),
  "gpt-4o": () => openai("gpt-4o"),
  "claude-sonnet-4-6": () => anthropic("claude-sonnet-4-6"),
  "claude-opus-4-6": () => anthropic("claude-opus-4-6"),
};

function getModel(modelId?: string): LanguageModel {
  const factory = MODELS[modelId ?? DEFAULT_MODEL];
  if (!factory) return MODELS[DEFAULT_MODEL]!();
  return factory();
}

const inspectEnvironment = tool({
  description:
    "Inspect the current execution environment. Returns runtime info (Node.js/Bun/Deno version), " +
    "OS details, CPU architecture, memory usage, environment variables, and platform metadata.",
  inputSchema: z.object({}),
  execute: async () => {
    const memUsage = process.memoryUsage();

    return {
      runtime: {
        name: typeof Bun !== "undefined" ? "bun" : typeof Deno !== "undefined" ? "deno" : "node",
        version: process.version,
        versions: {
          v8: process.versions.v8,
          openssl: process.versions.openssl,
          modules: process.versions.modules,
        },
      },
      os: {
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        type: os.type(),
        hostname: os.hostname(),
        uptime: `${Math.floor(os.uptime())}s`,
      },
      cpus: {
        count: os.cpus().length,
        model: os.cpus()[0]?.model,
      },
      memory: {
        total: `${Math.round(os.totalmem() / 1024 / 1024)}MB`,
        free: `${Math.round(os.freemem() / 1024 / 1024)}MB`,
        process: {
          rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
          heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
          heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
        },
      },
      env: {
        NODE_ENV: process.env.NODE_ENV,
        TZ: process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        LANG: process.env.LANG,
      },
      process: {
        pid: process.pid,
        cwd: process.cwd(),
        execPath: process.execPath,
        argv: process.argv.slice(0, 3),
      },
    };
  },
});

const webFetch = tool({
  description:
    "Fetch a URL and return the response as text. " +
    "Use this to retrieve web pages, APIs, or any HTTP resource.",
  inputSchema: z.object({
    url: z.string().url().describe("The URL to fetch"),
  }),
  execute: async ({ url }) => {
    const latency = Number(process.env.WEBFETCH_LATENCY_MS);
    if (latency > 0) {
      await new Promise((r) => setTimeout(r, latency));
    }

    const response = await fetch(url);
    let text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";

    if (contentType.includes("html")) {
      text = turndown.turndown(text);
    }

    return {
      status: response.status,
      contentType,
      body: text.slice(0, 2000),
      truncated: text.length > 2000,
    };
  },
});

// Silence TS errors for Bun/Deno global checks
declare const Bun: unknown;
declare const Deno: unknown;

// Per-run user context — loaded from DB in onChatStart, accessible everywhere
const userContext = chat.local<{
  userId: string;
  name: string;
  plan: "free" | "pro";
  preferredModel: string | null;
  messageCount: number;
}>({ id: "userContext" });

// Per-run dynamic tools — loaded from DB in onPreload/onChatStart
const userToolDefs = chat.local<{
  value: Array<{ name: string; description: string; responseTemplate: string }>;
}>({ id: "userToolDefs" });

// --------------------------------------------------------------------------
// Deep research — fetches multiple URLs and synthesizes the results.
// Plain tool (not a subtask) to avoid parallel wait issues.
// --------------------------------------------------------------------------
const deepResearch = tool({
  description:
    "Research a topic by fetching multiple URLs and synthesizing the results. " +
    "Streams progress updates to the chat as it works.",
  inputSchema: z.object({
    query: z.string().describe("The research query or topic"),
    urls: z.array(z.string().url()).describe("URLs to fetch and analyze"),
  }),
  execute: async ({ query, urls }) => {
    const partId = generateId();
    const results: { url: string; status: number; snippet: string }[] = [];

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]!;

      // Stream progress — runs in the chat.task process, so no target needed
      const { waitUntilComplete } = chat.stream.writer({
        execute: ({ write }) => {
          write({
            type: "data-research-progress" as any,
            id: partId,
            data: {
              status: "fetching" as const,
              query,
              current: i + 1,
              total: urls.length,
              currentUrl: url,
              completedUrls: results.map((r) => r.url),
            },
          });
        },
      });
      await waitUntilComplete();

      try {
        const response = await fetch(url);
        let text = await response.text();
        const contentType = response.headers.get("content-type") ?? "";

        if (contentType.includes("html")) {
          text = turndown.turndown(text);
        }

        results.push({
          url,
          status: response.status,
          snippet: text.slice(0, 500),
        });
      } catch (err) {
        results.push({
          url,
          status: 0,
          snippet: `Error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Final progress — done
    const { waitUntilComplete: waitForDone } = chat.stream.writer({
      execute: ({ write }) => {
        write({
          type: "data-research-progress" as any,
          id: partId,
          data: {
            status: "done" as const,
            query,
            current: urls.length,
            total: urls.length,
            completedUrls: results.map((r) => r.url),
          },
        });
      },
    });
    await waitForDone();

    return { query, results };
  },
});

export const aiChat = chat.task({
  id: "ai-chat",
  clientDataSchema: z.object({ model: z.string().optional(), userId: z.string() }),
  idleTimeoutInSeconds: 60,
  chatAccessTokenTTL: "2h",
  compaction: {
    shouldCompact: ({ totalTokens }) => (totalTokens ?? 0) > COMPACT_AFTER_TOKENS,
    summarize: async ({ messages }) => {
      const resolved = await compactionPrompt.resolve({});
      return generateText({
        model: registry.languageModel(resolved.model ?? "openai:gpt-4o-mini"),
        messages: [...messages, { role: "user" as const, content: resolved.text }],
        ...resolved.toAISDKTelemetry(),
      }).then((r) => r.text);
    },
    compactUIMessages: ({ uiMessages, summary }) => {
      return [
        {
          id: generateId(),
          role: "assistant" as const,
          parts: [{ type: "text" as const, text: `[Conversation summary]\n\n${summary}` }],
        },
        ...uiMessages.slice(-2),
      ];
    },
  },
  pendingMessages: {
    // Inject user messages between tool-call steps so the agent can adjust
    shouldInject: ({ steps }) => steps.length > 0,
    prepare: ({ messages }) => messages.length === 1
      ? [{ role: "user" as const, content: (messages[0]!.parts?.[0] as any)?.text ?? "" }]
      : [{ role: "user" as const, content: `The user sent ${messages.length} messages while you were working:\n\n${messages.map((m, i) => `${i + 1}. ${(m.parts?.[0] as any)?.text ?? ""}`).join("\n")}` }],
    // onReceived/onInjected are optional — the SDK automatically writes
    // a data-pending-message-injected chunk when injection happens.
  },
  prepareMessages: ({ messages, reason }) => {
    // Add Anthropic cache breaks to the last message for prompt caching.
    // Applied everywhere — run(), compaction rebuilds, compaction results.
    if (messages.length === 0) return messages;
    const last = messages[messages.length - 1]!;
    return [
      ...messages.slice(0, -1),
      {
        ...last,
        providerOptions: {
          ...last.providerOptions,
          anthropic: {
            ...(last.providerOptions?.anthropic as Record<string, unknown> | undefined),
            cacheControl: { type: "ephemeral" },
          },
        },
      },
    ];
  },
  uiMessageStreamOptions: {
    sendReasoning: true,
    onError: (error) => {
      // Log the full error server-side for debugging
      logger.error("Stream error", { error });
      // Return a sanitized message — this is what the frontend sees
      if (error instanceof Error && error.message.includes("rate limit")) {
        return "Rate limited — please wait a moment and try again.";
      }
      return "Something went wrong. Please try again.";
    },
  },
  onPreload: async ({ chatId, runId, chatAccessToken, clientData }) => {
    if (!clientData) return;
    // Eagerly initialize before the user's first message arrives
    const user = await prisma.user.upsert({
      where: { id: clientData.userId },
      create: { id: clientData.userId, name: "User" },
      update: {},
    });
    userContext.init({
      userId: user.id,
      name: user.name,
      plan: user.plan as "free" | "pro",
      preferredModel: user.preferredModel,
      messageCount: user.messageCount,
    });

    // Load user-specific dynamic tools
    const tools = await prisma.userTool.findMany({ where: { userId: clientData.userId } });
    userToolDefs.init({ value: tools });

    // Resolve prompt — versioned, overridable from dashboard
    const resolved = await systemPrompt.resolve({
      name: user.name,
      plan: user.plan as string,
    });
    chat.prompt.set(resolved);

    // Create chat record and session
    await prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: "New chat",
        userId: user.id,
        model: clientData?.model ?? DEFAULT_MODEL,
      },
      update: {},
    });
    await prisma.chatSession.upsert({
      where: { id: chatId },
      create: { id: chatId, runId, publicAccessToken: chatAccessToken },
      update: { runId, publicAccessToken: chatAccessToken },
    });
  },
  onChatStart: async ({ chatId, runId, chatAccessToken, clientData, continuation, preloaded }) => {
    if (preloaded) {
      // Everything was already initialized in onPreload — skip entirely.
      // The session, chat record, user context, and tools are all set up.
      return;
    }

    // Non-preloaded path: full initialization
    const user = await prisma.user.upsert({
      where: { id: clientData.userId },
      create: { id: clientData.userId, name: "User" },
      update: {},
    });
    userContext.init({
      userId: user.id,
      name: user.name,
      plan: user.plan as "free" | "pro",
      preferredModel: user.preferredModel,
      messageCount: user.messageCount,
    });

    // Load user-specific dynamic tools
    const tools = await prisma.userTool.findMany({ where: { userId: clientData.userId } });
    userToolDefs.init({ value: tools });

    // Resolve prompt — versioned, overridable from dashboard
    const resolved = await systemPrompt.resolve({
      name: user.name,
      plan: user.plan as string,
    });
    chat.prompt.set(resolved);

    if (!continuation) {
      await prisma.chat.upsert({
        where: { id: chatId },
        create: {
          id: chatId,
          title: "New chat",
          userId: user.id,
          model: clientData.model ?? DEFAULT_MODEL,
        },
        update: {},
      });
    }

    await prisma.chatSession.upsert({
      where: { id: chatId },
      create: { id: chatId, runId, publicAccessToken: chatAccessToken },
      update: { runId, publicAccessToken: chatAccessToken },
    });
  },
  onCompacted: async ({ summary, totalTokens, messageCount, chatId, turn }) => {
    logger.info("Conversation compacted", {
      chatId,
      turn,
      totalTokens,
      messageCount,
      summaryLength: summary.length,
    });
  },
  onTurnStart: async ({ chatId, uiMessages }) => {
    // Persist messages so mid-stream refresh still shows the user message.
    // Deferred — runs in parallel with streaming, awaited before onTurnComplete.
    chat.defer(prisma.chat.update({ where: { id: chatId }, data: { messages: uiMessages as any } }));
  },
  onTurnComplete: async ({ chatId, uiMessages, runId, chatAccessToken, lastEventId }) => {
    // Persist final messages + assistant response + stream position
    await prisma.chat.update({
      where: { id: chatId },
      data: { messages: uiMessages as any },
    });
    await prisma.chatSession.upsert({
      where: { id: chatId },
      create: { id: chatId, runId, publicAccessToken: chatAccessToken, lastEventId },
      update: { runId, publicAccessToken: chatAccessToken, lastEventId },
    });

    // Persist user context changes (message count, preferred model) if anything changed
    if (userContext.hasChanged()) {
      await prisma.user.update({
        where: { id: userContext.userId },
        data: {
          messageCount: userContext.messageCount,
          preferredModel: userContext.preferredModel,
        },
      });
    }
  },
  run: async ({ messages, clientData, stopSignal }) => {
    // Track usage
    userContext.messageCount++;

    // Remember their model choice
    if (clientData?.model) {
      userContext.preferredModel = clientData.model;
    }

    // Client-specified or user-preferred model overrides the prompt default
    const modelOverride = clientData?.model ?? userContext.preferredModel ?? undefined;
    const effectiveModel = modelOverride ?? chat.prompt().model ?? DEFAULT_MODEL;
    const useReasoning = REASONING_MODELS.has(effectiveModel);

    // Build dynamic tools from user's DB-configured tools (loaded in onPreload/onChatStart)
    const dynamicTools: Record<string, AITool<unknown, unknown>> = {};
    for (const t of userToolDefs.value ?? []) {
      dynamicTools[t.name] = dynamicTool({
        description: t.description,
        inputSchema: z.object({
          query: z.string().describe("The query or topic to look up"),
        }),
        execute: async (input) => {
          return { result: t.responseTemplate.replace("{{query}}", (input as any).query) };
        },
      });
    }

    return streamText({
      // Registry resolves the prompt's model (e.g. "openai:gpt-4o").
      // Client override takes precedence when provided.
      ...chat.toStreamTextOptions({
        registry,
        telemetry: clientData?.userId ? { userId: clientData.userId } : undefined,
      }),
      ...(modelOverride ? { model: getModel(modelOverride) } : {}),
      messages: messages,
      tools: {
        inspectEnvironment,
        webFetch,
        deepResearch,
        ...dynamicTools,
      },
      stopWhen: stepCountIs(10),
      abortSignal: stopSignal,
      providerOptions: {
        openai: { user: clientData?.userId },
        anthropic: {
          metadata: { user_id: clientData?.userId },
          ...(useReasoning ? { thinking: { type: "enabled", budgetTokens: 10000 } } : {}),
        },
      },
    });
  },
});

// --------------------------------------------------------------------------
// Raw task version — same functionality using composable primitives
// --------------------------------------------------------------------------

async function initUserContext(userId: string, chatId: string, model?: string) {
  const user = await prisma.user.upsert({
    where: { id: userId },
    create: { id: userId, name: "User" },
    update: {},
  });
  userContext.init({
    userId: user.id,
    name: user.name,
    plan: user.plan as "free" | "pro",
    preferredModel: user.preferredModel,
    messageCount: user.messageCount,
  });

  const tools = await prisma.userTool.findMany({ where: { userId } });
  userToolDefs.init({ value: tools });

  // Resolve prompt for the run
  const resolved = await systemPrompt.resolve({
    name: user.name,
    plan: user.plan as string,
  });
  chat.prompt.set(resolved);

  await prisma.chat.upsert({
    where: { id: chatId },
    create: { id: chatId, title: "New chat", userId: user.id, model: model ?? DEFAULT_MODEL },
    update: {},
  });
}

export const aiChatRaw = task({
  id: "ai-chat-raw",
  run: async (payload: ChatTaskWirePayload, { signal: runSignal }) => {
    let currentPayload = payload;
    const clientData = payload.metadata as { userId: string; model?: string } | undefined;

    // Handle preload — init early, then wait for first message
    if (currentPayload.trigger === "preload") {
      if (clientData) {
        await initUserContext(clientData.userId, currentPayload.chatId, clientData.model);
      }

      const result = await chat.messages.waitWithIdleTimeout({
        idleTimeoutInSeconds: payload.idleTimeoutInSeconds ?? 60,
        timeout: "1h",
        spanName: "waiting for first message",
      });
      if (!result.ok) return;
      currentPayload = result.output;
    }

    // Non-preloaded: init now
    const currentClientData = (currentPayload.metadata ?? clientData) as
      | { userId: string; model?: string }
      | undefined;

    if (!userContext.userId && currentClientData) {
      await initUserContext(currentClientData.userId, currentPayload.chatId, currentClientData.model);
    }

    const stop = chat.createStopSignal();
    const conversation = new chat.MessageAccumulator({
      compaction: {
        shouldCompact: ({ totalTokens }) => (totalTokens ?? 0) > COMPACT_AFTER_TOKENS,
        summarize: async ({ messages: msgs }) => {
          const resolved = await compactionPrompt.resolve({});
          return generateText({
            model: registry.languageModel(resolved.model ?? "openai:gpt-4o-mini"),
            ...resolved.toAISDKTelemetry(),
            messages: [...msgs, { role: "user" as const, content: resolved.text }],
          }).then((r) => r.text);
        },
        // Flatten to summary only in the raw task variant
        compactUIMessages: ({ summary }) => [
          {
            id: generateId(),
            role: "assistant" as const,
            parts: [{ type: "text" as const, text: `[Summary]\n\n${summary}` }],
          },
        ],
      },
      pendingMessages: {
        // Inject with a prefix so the LLM knows these are mid-execution corrections
        shouldInject: () => true,
        prepare: ({ messages }) => [{
          role: "user" as const,
          content: [{ type: "text" as const, text: `[User sent ${messages.length} message(s) while you were working]:\n${messages.map(m => (m.parts?.[0] as any)?.text ?? "").join("\n")}` }],
        }],
      },
    });

    for (let turn = 0; turn < 100; turn++) {
      stop.reset();

      const messages = await conversation.addIncoming(
        currentPayload.messages,
        currentPayload.trigger,
        turn
      );

      const turnClientData = (currentPayload.metadata ?? currentClientData) as
        | { userId: string; model?: string }
        | undefined;

      userContext.messageCount++;
      if (turnClientData?.model) {
        userContext.preferredModel = turnClientData.model;
      }

      const modelOverride = turnClientData?.model ?? userContext.preferredModel ?? undefined;
      const effectiveModel = modelOverride ?? chat.prompt().model ?? DEFAULT_MODEL;
      const useReasoning = REASONING_MODELS.has(effectiveModel);
      const combinedSignal = AbortSignal.any([runSignal, stop.signal]);

      const dynamicTools: Record<string, AITool<unknown, unknown>> = {};
      for (const t of userToolDefs.value ?? []) {
        dynamicTools[t.name] = dynamicTool({
          description: t.description,
          inputSchema: z.object({
            query: z.string().describe("The query or topic to look up"),
          }),
          execute: async (input) => {
            return { result: t.responseTemplate.replace("{{query}}", (input as any).query) };
          },
        });
      }

      // Listen for steering messages during streaming
      const steeringSub = chat.messages.on(async (msg) => {
        const lastMsg = msg.messages?.[msg.messages.length - 1];
        if (lastMsg) await conversation.steerAsync(lastMsg);
      });

      const result = streamText({
        ...chat.toStreamTextOptions({ registry }),
        ...(modelOverride ? { model: getModel(modelOverride) } : {}),
        messages: messages,
        tools: {
          inspectEnvironment,
          webFetch,
          deepResearch,
          ...dynamicTools,
        },
        stopWhen: stepCountIs(10),
        abortSignal: combinedSignal,
        providerOptions: {
          openai: { user: turnClientData?.userId },
          anthropic: {
            metadata: { user_id: turnClientData?.userId },
            ...(useReasoning ? { thinking: { type: "enabled", budgetTokens: 10000 } } : {}),
          },
        },
        prepareStep: conversation.prepareStep(),
      });

      let response: UIMessage | undefined;
      try {
        response = await chat.pipeAndCapture(result, { signal: combinedSignal });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          if (runSignal.aborted) break;
          // Stop — fall through
        } else {
          throw error;
        }
      } finally {
        steeringSub.off();
      }

      if (response) {
        if (stop.signal.aborted && !runSignal.aborted) {
          await conversation.addResponse(chat.cleanupAbortedParts(response));
        } else {
          await conversation.addResponse(response);
        }
      }

      if (runSignal.aborted) break;

      // Outer-loop compaction — runs if token threshold exceeded
      let turnUsage: LanguageModelUsage | undefined;
      try { turnUsage = await result.totalUsage; } catch { /* non-fatal */ }
      await conversation.compactIfNeeded(turnUsage, {
        chatId: currentPayload.chatId,
        turn,
      });

      // Persist messages
      await prisma.chat.update({
        where: { id: currentPayload.chatId },
        data: { messages: conversation.uiMessages as any },
      });

      if (userContext.hasChanged()) {
        await prisma.user.update({
          where: { id: userContext.userId },
          data: {
            messageCount: userContext.messageCount,
            preferredModel: userContext.preferredModel,
          },
        });
      }

      await chat.writeTurnComplete();

      const next = await chat.messages.waitWithIdleTimeout({
        idleTimeoutInSeconds: 60,
        timeout: "1h",
        spanName: "waiting for next message",
      });
      if (!next.ok) break;
      currentPayload = next.output;
    }

    stop.cleanup();
  },
});

// --------------------------------------------------------------------------
// Session iterator version — middle ground between chat.task and raw task
// --------------------------------------------------------------------------

export const aiChatSession = task({
  id: "ai-chat-session",
  run: async (payload: ChatTaskWirePayload, { signal }) => {
    const clientData = payload.metadata as { userId: string; model?: string } | undefined;

    // One-time init — just code at the top, no hooks needed
    if (clientData) {
      await initUserContext(clientData.userId, payload.chatId, clientData.model);
    }

    const session = chat.createSession(payload, {
      signal,
      idleTimeoutInSeconds: payload.idleTimeoutInSeconds ?? 60,
      timeout: "1h",
      compaction: {
        shouldCompact: ({ totalTokens }) => (totalTokens ?? 0) > COMPACT_AFTER_TOKENS,
        summarize: async ({ messages: msgs }) => {
          const resolved = await compactionPrompt.resolve({});
          return generateText({
            model: registry.languageModel(resolved.model ?? "openai:gpt-4o-mini"),
            ...resolved.toAISDKTelemetry(),
            messages: [...msgs, { role: "user" as const, content: resolved.text }],
          }).then((r) => r.text);
        },
        // Keep summary + last 4 messages in the session variant
        compactUIMessages: ({ uiMessages, summary }) => [
          {
            id: generateId(),
            role: "assistant" as const,
            parts: [{ type: "text" as const, text: `[Conversation summary]\n\n${summary}` }],
          },
          ...uiMessages.slice(-4),
        ],
      },
      pendingMessages: {
        // Always inject in the session variant
        shouldInject: () => true,
      },
    });

    for await (const turn of session) {
      const turnClientData = (turn.clientData ?? clientData) as
        | { userId: string; model?: string }
        | undefined;

      userContext.messageCount++;
      if (turnClientData?.model) userContext.preferredModel = turnClientData.model;

      const modelOverride = turnClientData?.model ?? userContext.preferredModel ?? undefined;
      const effectiveModel = modelOverride ?? chat.prompt().model ?? DEFAULT_MODEL;
      const useReasoning = REASONING_MODELS.has(effectiveModel);

      const result = streamText({
        ...chat.toStreamTextOptions({ registry }),
        ...(modelOverride ? { model: getModel(modelOverride) } : {}),
        messages: turn.messages,
        tools: {
          inspectEnvironment,
          webFetch,
          deepResearch,
        },
        stopWhen: stepCountIs(10),
        abortSignal: turn.signal,
        providerOptions: {
          openai: { user: turnClientData?.userId },
          anthropic: {
            metadata: { user_id: turnClientData?.userId },
            ...(useReasoning ? { thinking: { type: "enabled", budgetTokens: 10000 } } : {}),
          },
        },
      });

      await turn.complete(result);

      // Persist after each turn
      await prisma.chat.update({
        where: { id: turn.chatId },
        data: { messages: turn.uiMessages as any },
      });

      if (userContext.hasChanged()) {
        await prisma.user.update({
          where: { id: userContext.userId },
          data: {
            messageCount: userContext.messageCount,
            preferredModel: userContext.preferredModel,
          },
        });
      }
    }
  },
});
