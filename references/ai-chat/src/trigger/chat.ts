import { chat, ai } from "@trigger.dev/sdk/ai";
import { schemaTask } from "@trigger.dev/sdk";
import { streamText, tool, dynamicTool, stepCountIs, generateId } from "ai";
import type { LanguageModel, Tool as AITool } from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import os from "node:os";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../lib/generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

import { DEFAULT_MODEL, REASONING_MODELS } from "@/lib/models";

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

    // Strip HTML to plain text for readability
    if (contentType.includes("html")) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
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
const userToolDefs = chat.local<
  Array<{ name: string; description: string; responseTemplate: string }>
>({ id: "userToolDefs" });

// --------------------------------------------------------------------------
// Subtask: deep research — fetches multiple URLs and streams progress
// back to the parent chat via chat.stream using data-* chunks
// --------------------------------------------------------------------------
export const deepResearch = schemaTask({
  id: "deep-research",
  description:
    "Research a topic by fetching multiple URLs and synthesizing the results. " +
    "Streams progress updates to the chat as it works.",
  schema: z.object({
    query: z.string().describe("The research query or topic"),
    urls: z.array(z.string().url()).describe("URLs to fetch and analyze"),
  }),
  run: async ({ query, urls }) => {
    // Access chat context from the parent chat.task — typed via typeof aiChat
    const { chatId, clientData } = ai.chatContextOrThrow<typeof aiChat>();
    console.log(`Deep research for chat ${chatId}, user ${clientData?.userId}`);

    const partId = generateId();
    const results: { url: string; status: number; snippet: string }[] = [];

    // Stream progress using data-research-progress chunks.
    // Using the same id means each write updates the same part in the message.
    function streamProgress(progress: {
      status: "fetching" | "done";
      query: string;
      current: number;
      total: number;
      currentUrl?: string;
      completedUrls: string[];
    }) {
      return chat.stream.writer({
        target: "root",
        execute: ({ write }) => {
          write({
            type: "data-research-progress" as any,
            id: partId,
            data: progress,
          });
        },
      });
    }

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]!;

      // Update progress — fetching
      const { waitUntilComplete } = streamProgress({
        status: "fetching",
        query,
        current: i + 1,
        total: urls.length,
        currentUrl: url,
        completedUrls: results.map((r) => r.url),
      });
      await waitUntilComplete();

      try {
        const response = await fetch(url);
        let text = await response.text();
        const contentType = response.headers.get("content-type") ?? "";

        if (contentType.includes("html")) {
          text = text
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/\s+/g, " ")
            .trim();
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

    // Final progress update — done
    const { waitUntilComplete: waitForDone } = streamProgress({
      status: "done",
      query,
      current: urls.length,
      total: urls.length,
      completedUrls: results.map((r) => r.url),
    });
    await waitForDone();

    return { query, results };
  },
});

export const aiChat = chat.task({
  id: "ai-chat",
  clientDataSchema: z.object({ model: z.string().optional(), userId: z.string() }),
  warmTimeoutInSeconds: 60,
  chatAccessTokenTTL: "2h",
  onPreload: async ({ chatId, runId, chatAccessToken, clientData }) => {
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
    userToolDefs.init(tools);

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
      // Already initialized in onPreload — just update session
      await prisma.chatSession.upsert({
        where: { id: chatId },
        create: { id: chatId, runId, publicAccessToken: chatAccessToken },
        update: { runId, publicAccessToken: chatAccessToken },
      });
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
    userToolDefs.init(tools);

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
  onTurnStart: async ({ chatId, uiMessages, runId, chatAccessToken }) => {
    // Persist messages BEFORE streaming so mid-stream refresh has the user message
    await prisma.chat.update({
      where: { id: chatId },
      data: { messages: uiMessages as any },
    });
    await prisma.chatSession.upsert({
      where: { id: chatId },
      create: { id: chatId, runId, publicAccessToken: chatAccessToken },
      update: { runId, publicAccessToken: chatAccessToken },
    });
  },
  onTurnComplete: async ({ chatId, uiMessages, runId, chatAccessToken, lastEventId, clientData, stopped }) => {
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

    // Use preferred model if none specified
    const modelId = clientData?.model ?? userContext.preferredModel ?? undefined;
    const useReasoning = REASONING_MODELS.has(modelId ?? DEFAULT_MODEL);

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
      model: getModel(modelId),
      system: `You are a helpful assistant for ${userContext.name} (${userContext.plan} plan). Be concise and friendly.`,
      messages,
      tools: {
        inspectEnvironment,
        webFetch,
        deepResearch: ai.tool(deepResearch),
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
      experimental_telemetry: {
        isEnabled: true,
      },
    });
  },
});
