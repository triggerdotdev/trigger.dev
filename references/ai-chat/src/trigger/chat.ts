import { chat } from "@trigger.dev/sdk/ai";
import { streamText, tool, stepCountIs } from "ai";
import type { LanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import os from "node:os";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../lib/generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

import { DEFAULT_MODEL } from "@/lib/models";

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
}>();

export const aiChat = chat.task({
  id: "ai-chat",
  clientDataSchema: z.object({ model: z.string().optional(), userId: z.string() }),
  warmTimeoutInSeconds: 60,
  chatAccessTokenTTL: "2h",
  onChatStart: async ({ chatId, runId, chatAccessToken, clientData }) => {
    // Load user context from DB — available for the entire run
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

    await prisma.chat.upsert({
      where: { id: chatId },
      create: { id: chatId, title: "New chat", userId: user.id },
      update: {},
    });
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
  onTurnComplete: async ({ chatId, uiMessages, runId, chatAccessToken, lastEventId, clientData }) => {
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

    return streamText({
      model: getModel(modelId),
      system: `You are a helpful assistant for ${userContext.name} (${userContext.plan} plan). Be concise and friendly.`,
      messages,
      tools: { inspectEnvironment },
      stopWhen: stepCountIs(10),
      abortSignal: stopSignal,
      providerOptions: {
        openai: { user: clientData?.userId },
        anthropic: { metadata: { user_id: clientData?.userId } },
      },
      experimental_telemetry: {
        isEnabled: true,
      },
    });
  },
});
