import { chat } from "@trigger.dev/sdk/ai";
import { logger, prompts } from "@trigger.dev/sdk";
import { streamText, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { prisma } from "./db";
import { buildAssistantTools } from "./ai-assistant-tools";

type ChatMessagesForWrite = NonNullable<
  Parameters<typeof prisma.aiChat.update>[0]["data"]
>["messages"];

// Idempotently create the chat + session rows before onTurnStart's update
// runs. Must happen in onPreload (every chat boots preloaded) with onChatStart
// as the non-preloaded fallback.
async function ensureChatRows(args: {
  chatId: string;
  chatAccessToken: string;
  userId: string;
}) {
  await prisma.aiChat.upsert({
    where: { id: args.chatId },
    create: {
      id: args.chatId,
      title: "New chat",
      userId: args.userId,
      model: "gpt-4.1-mini",
    },
    update: {},
  });
  await prisma.aiChatSession.upsert({
    where: { id: args.chatId },
    create: { id: args.chatId, publicAccessToken: args.chatAccessToken },
    update: { publicAccessToken: args.chatAccessToken },
  });
}

const systemPrompt = prompts.define({
  id: "dashboard-assistant-system",
  model: "openai:gpt-4.1-mini",
  config: { temperature: 0.7 },
  variables: z.object({
    projectSlug: z.string(),
    environmentSlug: z.string(),
    currentPage: z.string(),
  }),
  content: `You are the Trigger.dev AI assistant, embedded in the dashboard.

## Your role
Help the user navigate the dashboard, find documentation, and understand Trigger.dev features.

## Current context
The user is viewing: project "{{projectSlug}}" / {{environmentSlug}} environment / {{currentPage}} page.

## Guidelines
- Be concise and friendly. Prefer short, direct answers unless the user asks for detail.
- When the user asks how something works, ALWAYS search documentation first.
- When the user asks "where do I find X" or "take me to Y", use navigateToPage.
- Use getCurrentContext to ground answers in what the user is viewing.
- Use markdown formatting for code blocks, lists, and structured output.
- If you don't know something, say so — don't make things up.
- When you use a tool, briefly explain what you're doing.

## What you CAN do (V1A)
- Search and read Trigger.dev documentation
- Navigate the user to any dashboard page
- Explain Trigger.dev features, configuration, and APIs
- Help with common questions about retries, concurrency, deployments, env vars, etc.

## What you CANNOT do yet
- Inspect specific runs, errors, or logs (coming soon)
- Modify settings or trigger actions (coming soon)
- Access the user's code (coming soon)`,
});

export const dashboardAssistant = chat
  .withClientData({
    schema: z.object({
      userId: z.string(),
      organizationSlug: z.string(),
      projectSlug: z.string(),
      environmentSlug: z.string(),
      currentPage: z.string(),
      currentParams: z.record(z.string()).optional(),
    }),
  })
  .agent({
    id: "dashboard-assistant",
    idleTimeoutInSeconds: 60,
    chatAccessTokenTTL: "1h",

    // Declared here (not just on streamText) so the SDK re-applies each tool's
    // `toModelOutput` when re-converting prior-turn history. run() reads them
    // back via `tools`.
    tools: ({ clientData }) => buildAssistantTools(clientData!),

    uiMessageStreamOptions: {
      onError: (error: unknown) => {
        logger.error("Stream error", { error });
        if (error instanceof Error && error.message.includes("rate limit")) {
          return "Rate limited — please wait a moment and try again.";
        }
        return "Something went wrong. Please try again.";
      },
    },

    onBoot: async ({ clientData }) => {
      if (!clientData) return;
      const resolved = await systemPrompt.resolve({
        projectSlug: clientData.projectSlug,
        environmentSlug: clientData.environmentSlug,
        currentPage: clientData.currentPage,
      });
      chat.prompt.set(resolved);
    },

    onPreload: async ({ chatId, chatAccessToken, clientData }) => {
      if (!clientData) return;
      await ensureChatRows({ chatId, chatAccessToken, userId: clientData.userId });
    },

    // Fallback for non-preloaded runs; onPreload already created the rows.
    onChatStart: async ({ chatId, chatAccessToken, clientData, preloaded }) => {
      if (preloaded) return;
      if (!clientData) return;
      await ensureChatRows({ chatId, chatAccessToken, userId: clientData.userId });
    },

    // Await the write (not chat.defer): a deferred write loses the user
    // message on a mid-stream page refresh.
    onTurnStart: async ({ chatId, uiMessages }) => {
      await prisma.aiChat.update({
        where: { id: chatId },
        data: { messages: uiMessages as unknown as ChatMessagesForWrite },
      });

      if (Array.isArray(uiMessages)) {
        const firstUser = uiMessages.find((m) => m?.role === "user");
        const text = firstUser
          ? (firstUser.parts ?? [])
              .filter((p: { type?: string }) => p?.type === "text")
              .map((p: { text?: string }) => p.text ?? "")
              .join(" ")
              .trim()
          : "";
        if (text) {
          const title = text.length > 60 ? `${text.slice(0, 60).trimEnd()}…` : text;
          await prisma.aiChat.updateMany({
            where: { id: chatId, title: "New chat" },
            data: { title },
          });
        }
      }
    },

    // Atomic write of messages + session state; a non-atomic write races the
    // resume-replay.
    onTurnComplete: async ({ chatId, uiMessages, chatAccessToken, lastEventId }) => {
      await prisma.$transaction([
        prisma.aiChat.update({
          where: { id: chatId },
          data: { messages: uiMessages as unknown as ChatMessagesForWrite },
        }),
        prisma.aiChatSession.upsert({
          where: { id: chatId },
          create: { id: chatId, publicAccessToken: chatAccessToken, lastEventId },
          update: { publicAccessToken: chatAccessToken, lastEventId },
        }),
      ]);
    },

    // chat.toStreamTextOptions() must be spread first. `tools` comes from the
    // run payload so streamText and the history re-converter see the same set.
    run: async ({ messages, tools, stopSignal }) => {
      return streamText({
        ...chat.toStreamTextOptions({ tools }),
        model: openai("gpt-4.1-mini"),
        messages,
        abortSignal: stopSignal,
        stopWhen: stepCountIs(5),
      });
    },
  });