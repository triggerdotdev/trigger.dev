import { chat } from "@trigger.dev/sdk/ai";
import { logger, prompts, sessions } from "@trigger.dev/sdk";
import { streamText, stepCountIs, generateText, generateId } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { prisma } from "./db";
import { buildAssistantTools } from "./ai-assistant-tools";

type ChatMessagesForWrite = NonNullable<
  Parameters<typeof prisma.aiChat.update>[0]["data"]
>["messages"];

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
Help the user navigate the dashboard, find documentation, understand Trigger.dev features, and investigate runs and errors.

## Current context
The user is viewing: project "{{projectSlug}}" / {{environmentSlug}} environment / {{currentPage}} page.

## Guidelines
- Be concise and friendly. Prefer short, direct answers unless the user asks for detail.
- When the user asks how something works, ALWAYS search documentation first.
- When the user asks "where do I find X" or "take me to Y", use navigateToPage. To open a specific run, call navigateToPage with that run's friendly ID as runId (and a spanId to deep-link to a specific span/subtrace within its trace).
- Use getCurrentContext to ground answers in what the user is viewing. If the user refers to "this run" or "the run I'm looking at" without an ID, check getCurrentContext for a run ID in the current params before asking.
- To investigate why a run failed, call getRunDetails first — its trace lists each span with an \`id\` and an \`isError\` flag. Then call getSpanDetails with the failing span's \`id\` to read the exact exception, stack trace, and metadata for that subtrace. Don't guess the cause from the span message alone — drill in.
- Use markdown formatting for code blocks and prose. Do NOT format tool data as markdown tables.
- If you don't know something, say so — don't make things up.
- When you use a tool, briefly explain what you're doing.

## Rendering tool results
Run, error, and analytics tool results (listRuns, listErrors, queryRuns, aggregateRuns, classifyFailure, applyRunFilters, etc.) are rendered for the user as rich UI — tables, cards, and chips — directly from the tool output. Do NOT repeat that data in your reply: never re-list the rows as a bullet list or a hand-written markdown table, even if the user says "show it as a table" (the table is already there). After a data tool runs, just give a one-line summary (e.g. "Here are your 8 most recent failed runs") and let the rendered component show the rows.

## Completing multi-step requests
Many requests have several parts — e.g. "go to the runs page and show me the failed ones" is two steps: (1) navigate there, then (2) inspect and show the results. Carry out EVERY part in the same turn by chaining tool calls: act on the first part, then immediately continue to the next. Do NOT stop after the first step to ask "do you want me to do the next thing?" — the user already asked for it, so just do it. Only pause to ask a question when a step is genuinely ambiguous (you can't tell what the user means) or would change/delete something.

## What you CAN do
- Search and read Trigger.dev documentation
- Navigate the user to any dashboard page, or deep-link straight to a run or a span within its trace
- Explain Trigger.dev features, configuration, and APIs
- Help with common questions about retries, concurrency, deployments, env vars, etc.
- Inspect specific runs, errors, and logs — including drilling into an individual span (subtrace) to read its exact exception and metadata
- Analyze run failures and trends
- Find similar errors and correlate with deployments

## What you CANNOT do yet
- Modify settings or trigger actions
- Access the user's code

## When explaining why a run failed, use this format:

**Summary:** One sentence.
**Category:** Timeout / OOM / Missing env var / Child task failed / User code exception / AI provider error / Deploy regression / Platform issue / Unknown
**Likely cause:** 1-2 sentences with evidence.
**Confidence:** High / Medium / Low
**Evidence:**
- Error: <message>
- Failed span: <name, duration>
- Deploy: <version, time since deploy>`,
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
    tools: async (event) => buildAssistantTools(event.clientData!),

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

    // Persist messages after turn completes
    onTurnComplete: async ({ chatId, uiMessages }) => {
      await prisma.aiChat.update({
        where: { id: chatId },
        data: { messages: uiMessages as unknown as ChatMessagesForWrite },
      });
    },

    compaction: {
      shouldCompact: ({ totalTokens }) => (totalTokens ?? 0) > 80_000,
      summarize: async ({ messages }) => {
        return generateText({
          model: openai("gpt-4.1-mini"),
          messages: [
            ...messages,
            {
              role: "user",
              content: "Summarize this conversation concisely. Capture key topics, " +
                "questions asked, answers given, runs/errors inspected, and any " +
                "conclusions reached. Keep context needed to continue naturally.",
            },
          ],
        }).then((r) => r.text);
      },
      compactUIMessages: ({ uiMessages, summary }) => [
        {
          id: generateId(),
          role: "assistant",
          parts: [{ type: "text", text: `[Conversation summary]\n\n${summary}` }],
        },
        ...uiMessages.slice(-2),
      ],
    },

    pendingMessages: {
      shouldInject: ({ steps }) => steps.length > 0,
      prepare: ({ messages }) => {
        const getMessageText = (m: any) => {
          const textPart = m?.parts?.find((p: any) => p?.type === "text");
          return textPart?.text ?? "";
        };

        if (messages.length === 1) {
          return [{ role: "user", content: getMessageText(messages[0]) }];
        }

        const messageList = messages
          .map((m, i) => `${i + 1}. ${getMessageText(m)}`)
          .join("\n");
        return [{
          role: "user",
          content: `The user sent ${messages.length} messages while you were working:\n\n${messageList}`,
        }];
      },
    },

    // chat.toStreamTextOptions() must be spread first. `tools` comes from the
    // run payload so streamText and the history re-converter see the same set.
    run: async ({ messages, tools, stopSignal }) => {
      return streamText({
        ...chat.toStreamTextOptions({ tools }),
        model: openai("gpt-4.1-mini"),
        messages,
        abortSignal: stopSignal,
        stopWhen: stepCountIs(10),
      });
    },
  });