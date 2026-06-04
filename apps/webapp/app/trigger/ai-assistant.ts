import { chat } from "@trigger.dev/sdk/ai";
import { logger, sessions } from "@trigger.dev/sdk";
import { streamText, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { prisma } from "./db";
import { buildAssistantTools } from "./ai-assistant-tools";
import { routerSystemPrompt } from "./ai-assistant-tools/router/prompt";

type ChatMessagesForWrite = NonNullable<
  Parameters<typeof prisma.aiChat.update>[0]["data"]
>["messages"];

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
      const resolved = await routerSystemPrompt.resolve({
        projectSlug: clientData.projectSlug,
        environmentSlug: clientData.environmentSlug,
        currentPage: clientData.currentPage,
      });
      chat.prompt.set(resolved);
    },

    onPreload: async ({ chatId, clientData }) => {
      if (!clientData) return;
      // Create session through Trigger platform and local chat record
      await sessions.start({
        type: "chat.agent",
        externalId: chatId,
        taskIdentifier: "dashboard-assistant",
        triggerConfig: {
          basePayload: {
            userId: clientData.userId,
            organizationSlug: clientData.organizationSlug,
            projectSlug: clientData.projectSlug,
            environmentSlug: clientData.environmentSlug,
            currentPage: clientData.currentPage,
            currentParams: clientData.currentParams,
          },
        },
        tags: [
          `user:${clientData.userId}`,
          `org:${clientData.organizationSlug}`,
          `project:${clientData.projectSlug}`,
        ],
      });
    },

    // Fallback for non-preloaded runs; onPreload already created the session.
    onChatStart: async ({ chatId, clientData, preloaded }) => {
      if (preloaded) return;
      if (!clientData) return;
      // Create session through Trigger platform and local chat record
      await sessions.start({
        type: "chat.agent",
        externalId: chatId,
        taskIdentifier: "dashboard-assistant",
        triggerConfig: {
          basePayload: {
            userId: clientData.userId,
            organizationSlug: clientData.organizationSlug,
            projectSlug: clientData.projectSlug,
            environmentSlug: clientData.environmentSlug,
            currentPage: clientData.currentPage,
            currentParams: clientData.currentParams,
          },
        },
        tags: [
          `user:${clientData.userId}`,
          `org:${clientData.organizationSlug}`,
          `project:${clientData.projectSlug}`,
        ],
      });
    },

    // Await the write (not chat.defer): a deferred write loses the user
    // message on a mid-stream page refresh.
    onTurnStart: async ({ chatId, uiMessages, clientData }) => {
      const messages = uiMessages as unknown as ChatMessagesForWrite;
      await prisma.aiChat.upsert({
        where: { id: chatId },
        create: {
          id: chatId,
          title: "New chat",
          userId: clientData?.userId ?? "",
          model: "gpt-4.1-mini",
          messages,
        },
        update: { messages },
      });

      if (Array.isArray(uiMessages)) {
        const firstUser = uiMessages.find((m) => m?.role === "user");
        const parts = (firstUser?.parts ?? []) as Array<{ type?: string; text?: string }>;
        const text = parts
          .filter((p) => p?.type === "text")
          .map((p) => p.text ?? "")
          .join(" ")
          .trim();
        if (text) {
          const title = text.length > 60 ? `${text.slice(0, 60).trimEnd()}…` : text;
          await prisma.aiChat.updateMany({
            where: { id: chatId, title: "New chat" },
            data: { title },
          });
        }
      }
    },

    // Persist messages after turn completes
    onTurnComplete: async ({ chatId, uiMessages }) => {
      await prisma.aiChat.update({
        where: { id: chatId },
        data: { messages: uiMessages as unknown as ChatMessagesForWrite },
      });
    },

    // chat.toStreamTextOptions() must be spread first. `tools` comes from the
    // run payload so streamText and the history re-converter see the same set.
    run: async ({ messages, tools, stopSignal }) => {
      return streamText({
        ...chat.toStreamTextOptions({ tools }),
        model: openai("gpt-4.1-mini"),
        messages,
        abortSignal: stopSignal,
        // Allow multi-step tool chains with room for self-correcting retries:
        // searchApi → getApiDetails → callApi (→ retry on error), or
        // getTableSchema → executeTrql → summarize.
        stopWhen: stepCountIs(16),
      });
    },
  });