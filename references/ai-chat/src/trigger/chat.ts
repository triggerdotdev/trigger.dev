import { chat, type ChatTaskWirePayload } from "@trigger.dev/sdk/ai";
import { logger, prompts, skills } from "@trigger.dev/sdk";

import {
  streamText,
  generateText,
  generateObject,
  stepCountIs,
  generateId,
  createProviderRegistry,
  validateUIMessages,
} from "ai";
import type { LanguageModel, LanguageModelUsage, UIMessage } from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../lib/generated/prisma/client";
import {
  chatTools,
  deepResearch,
  inspectEnvironment,
  webFetch,
  type ChatUiMessage,
} from "@/lib/chat-tools";
import { disposeCodeSandboxForRun, warmCodeSandbox } from "@/lib/code-sandbox";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

/** Prisma `messages` JSON column — use write-side type for updates (not `JsonValue` from reads). */
export type ChatMessagesForWrite = NonNullable<
  Parameters<typeof prisma.chat.update>[0]["data"]
>["messages"];

import { DEFAULT_MODEL, REASONING_MODELS } from "@/lib/models";

function textFromFirstPart(message: UIMessage): string {
  const p = message.parts?.[0];
  return p?.type === "text" ? p.text : "";
}
const COMPACT_AFTER_TOKENS = Number(process.env.COMPACT_AFTER_TOKENS) || 80_000;

const registry = createProviderRegistry({ openai, anthropic });

type RegistryLanguageModelId = Parameters<typeof registry.languageModel>[0];

function registryLanguageModel(
  id: string | undefined,
  fallback: RegistryLanguageModelId
): LanguageModel {
  return registry.languageModel((id ?? fallback) as RegistryLanguageModelId);
}

// #region Managed prompts — versioned, overridable from dashboard
const compactionPrompt = prompts.define({
  id: "ai-chat-compaction",
  model: "openai:gpt-4o-mini" satisfies RegistryLanguageModelId,
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
  model: "openai:gpt-4o" satisfies RegistryLanguageModelId,
  config: { temperature: 0.7 },
  variables: z.object({ name: z.string(), plan: z.string() }),
  content: `You are a helpful AI assistant for {{name}} on the {{plan}} plan.

## Guidelines
- Be concise and friendly. Prefer short, direct answers unless the user asks for detail.
- When using tools, explain what you're doing briefly before invoking them.
- If you don't know something, say so — don't make things up.

## Capabilities
You can inspect the execution environment, fetch web pages, perform multi-URL deep research,
query PostHog with HogQL, and run short code snippets in an isolated sandbox (e.g. to analyze query results).
When the user asks you to research a topic, use the deep research tool with relevant URLs.

## Tone
- Match the user's formality level. If they're casual, be casual back.
- Use markdown formatting for code blocks, lists, and structured output.
- Keep responses under a few paragraphs unless the user asks for more.`,
});

const timeUtilsSkill = skills.define({
  id: "time-utils",
  path: "./skills/time-utils",
});

const selfReviewPrompt = prompts.define({
  id: "ai-chat-self-review",
  model: "openai:gpt-4o-mini" satisfies RegistryLanguageModelId,
  content: `You are a conversation quality reviewer. Analyze the assistant's most recent response and provide structured feedback.

Focus on:
- Whether the response actually answered the user's question
- Missed opportunities to use tools or provide more detail
- Tone mismatches (too formal, too casual, etc.)
- Factual claims that should have been verified with tools

Be concise. Only flag issues worth fixing — don't nitpick.`,
});
// #endregion

// #region Models and helpers
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

const DEFAULT_REGISTRY_MODEL_ID = "anthropic:claude-sonnet-4-6" as const satisfies RegistryLanguageModelId;

function languageModelForChatTurn(modelOverride: string | null | undefined): LanguageModel {
  if (modelOverride) {
    return getModel(modelOverride);
  }
  return registryLanguageModel(chat.prompt().model, DEFAULT_REGISTRY_MODEL_ID);
}

function useExtendedThinking(modelOverride: string | null | undefined): boolean {
  if (modelOverride && REASONING_MODELS.has(modelOverride)) {
    return true;
  }
  const promptModel = chat.prompt().model;
  return promptModel != null && promptModel.includes("claude-opus-4-6");
}
// #endregion

// #region Per-run state — chat.local persists across turns in the same run
const userContext = chat.local<{
  userId: string;
  name: string;
  plan: "free" | "pro";
  preferredModel: string | null;
  messageCount: number;
}>({ id: "userContext" });
// #endregion

// ============================================================================
// chat.agent — the main chat agent
// ============================================================================

export const aiChat = chat
  .withUIMessage<ChatUiMessage>({
    streamOptions: {
      sendReasoning: true,
      onError: (error) => {
        logger.error("Stream error", { error });
        if (error instanceof Error && error.message.includes("rate limit")) {
          return "Rate limited — please wait a moment and try again.";
        }
        return "Something went wrong. Please try again.";
      },
    },
  })
  .withClientData({
    schema: z.object({ model: z.string().optional(), userId: z.string() }),
  })
  .onChatSuspend(async ({ phase, ctx }) => {
    logger.debug("Chat suspending", { phase, runId: ctx.run.id });
    await disposeCodeSandboxForRun(ctx.run.id);
  })
  .onChatResume(async ({ phase, ctx }) => {
    logger.debug("Chat resumed", { phase, runId: ctx.run.id });
  })
  .agent({
    id: "ai-chat",
    idleTimeoutInSeconds: 60,
    chatAccessTokenTTL: "1h",

    // #region Compaction — automatic context window management
    compaction: {
      shouldCompact: ({ totalTokens }) => (totalTokens ?? 0) > COMPACT_AFTER_TOKENS,
      summarize: async ({ messages }) => {
        const resolved = await compactionPrompt.resolve({});
        return generateText({
          model: registryLanguageModel(resolved.model, "openai:gpt-4o-mini"),
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
    // #endregion

    // #region Pending messages — user can steer the agent mid-response
    pendingMessages: {
      shouldInject: ({ steps }) => steps.length > 0,
      prepare: ({ messages }) =>
        messages.length === 1
          ? [{ role: "user" as const, content: textFromFirstPart(messages[0]!) }]
          : [
            {
              role: "user" as const,
              content: `The user sent ${messages.length
                } messages while you were working:\n\n${messages
                  .map((m, i) => `${i + 1}. ${textFromFirstPart(m)}`)
                  .join("\n")}`,
            },
          ],
    },
    // #endregion

    // #region onValidateMessages — validate UIMessages before model conversion
    onValidateMessages: async ({ messages, turn }) => {
      logger.info("Validating UI messages", {
        turn,
        count: messages.length,
      });
      return validateUIMessages({ messages, tools: chatTools });
    },
    // #endregion

    // #region prepareMessages — runs before every LLM call
    prepareMessages: ({ messages, reason }) => {
      // Add Anthropic cache breaks to the last message for prompt caching.
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
    // #endregion

    // --- Lifecycle hooks ---

    // #region onPreload — eagerly initialize before the user's first message
    onPreload: async ({ chatId, runId, chatAccessToken, clientData }) => {
      if (!clientData) return;
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

      const resolved = await systemPrompt.resolve({
        name: user.name,
        plan: user.plan as string,
      });
      chat.prompt.set(resolved);
      chat.skills.set([await timeUtilsSkill.local()]);

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
        create: { id: chatId, publicAccessToken: chatAccessToken },
        update: { publicAccessToken: chatAccessToken },
      });
    },
    // #endregion

    // #region onChatStart — fallback init when not preloaded
    onChatStart: async ({
      chatId,
      runId,
      chatAccessToken,
      clientData,
      continuation,
      preloaded,
    }) => {
      if (preloaded) return;

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

      const resolved = await systemPrompt.resolve({
        name: user.name,
        plan: user.plan as string,
      });
      chat.prompt.set(resolved);
      chat.skills.set([await timeUtilsSkill.local()]);

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
        create: { id: chatId, publicAccessToken: chatAccessToken },
        update: { publicAccessToken: chatAccessToken },
      });
    },
    // #endregion

    // #region onCompacted
    onCompacted: async ({ summary, totalTokens, messageCount, chatId, turn }) => {
      logger.info("Conversation compacted", {
        chatId,
        turn,
        totalTokens,
        messageCount,
        summaryLength: summary.length,
      });
    },
    // #endregion

    // #region onTurnStart — persist messages + write status via writer
    onTurnStart: async ({ chatId, uiMessages, writer, runId }) => {
      warmCodeSandbox(runId);
      writer.write({ type: "data-turn-status", data: { status: "preparing" }, transient: true });
      // Awaited (not chat.defer) so the user message is durable before
      // streaming begins. A mid-stream page refresh reads from DB; if the
      // write is still in flight, getChatMessages returns [] and the
      // resumed SSE stream rebuilds an assistant-only conversation,
      // dropping the user message from the UI.
      await prisma.chat.update({
        where: { id: chatId },
        data: { messages: uiMessages as unknown as ChatMessagesForWrite },
      });
    },
    // #endregion

    onComplete: async ({ ctx }) => {
      await disposeCodeSandboxForRun(ctx.run.id);
    },

    // #region onBeforeTurnComplete — add a persistent data part to test chat.response
    onBeforeTurnComplete: async ({ writer, turn }) => {
      writer.write({
        type: "data-turn-metadata",
        data: { turn, timestamp: Date.now(), source: "onBeforeTurnComplete" },
      });
    },
    // #endregion

    // #region onTurnComplete — persist + background self-review via chat.inject()
    onTurnComplete: async ({
      chatId,
      uiMessages,
      messages,
      responseMessage,
      runId,
      chatAccessToken,
      lastEventId,
    }) => {
      // Log responseMessage parts for debugging TRI-8556
      const partTypes = responseMessage?.parts?.map((p: any) => p.type) ?? [];
      const toolParts = responseMessage?.parts?.filter((p: any) => p.type?.startsWith("tool-")) ?? [];
      logger.info("onTurnComplete responseMessage", {
        hasResponseMessage: !!responseMessage,
        responseMessageId: responseMessage?.id,
        totalParts: responseMessage?.parts?.length ?? 0,
        partTypes,
        toolPartsCount: toolParts.length,
        toolParts: toolParts.map((p: any) => ({ type: p.type, state: p.state, toolCallId: p.toolCallId })),
      });
      // Atomic so the page-load `Promise.all([getChatMessages, getSessionForChat])`
      // can't observe a state where messages are post-write but lastEventId is
      // still pre-write — that race causes resume to replay this turn's chunks
      // on top of the persisted assistant message and duplicates the render.
      await prisma.$transaction([
        prisma.chat.update({
          where: { id: chatId },
          data: { messages: uiMessages as unknown as ChatMessagesForWrite },
        }),
        prisma.chatSession.upsert({
          where: { id: chatId },
          create: { id: chatId, publicAccessToken: chatAccessToken, lastEventId },
          update: { publicAccessToken: chatAccessToken, lastEventId },
        }),
      ]);

      // Background self-review — a cheap model critiques the response and
      // injects coaching into the conversation before the next user message.
      chat.defer(
        (async () => {
          const resolved = await selfReviewPrompt.resolve({});

          const review = await generateObject({
            model: registryLanguageModel(resolved.model, "openai:gpt-4o-mini"),
            ...resolved.toAISDKTelemetry(),
            system: resolved.text,
            prompt: `Here is the conversation to review:\n\n${messages
              .filter((m) => m.role === "user" || m.role === "assistant")
              .map(
                (m) =>
                  `${m.role}: ${typeof m.content === "string"
                    ? m.content
                    : Array.isArray(m.content)
                      ? m.content
                        .filter((p: any) => p.type === "text")
                        .map((p: any) => p.text)
                        .join("")
                      : ""
                  }`
              )
              .join("\n\n")}`,
            schema: z.object({
              needsImprovement: z.boolean().describe("Whether the response needs improvement"),
              suggestions: z
                .array(z.string())
                .describe("Specific actionable suggestions for the next response"),
              missedTools: z
                .array(z.string())
                .describe("Tool names the assistant should have used but didn't"),
            }),
          });

          const parts = [];
          if (review.object.suggestions.length > 0) {
            parts.push(
              `Suggestions:\n${review.object.suggestions.map((s) => `- ${s}`).join("\n")}`
            );
          }
          if (review.object.missedTools.length > 0) {
            parts.push(`Consider using: ${review.object.missedTools.join(", ")}`);
          }

          chat.inject([
            {
              role: "user" as const,
              content: review.object.needsImprovement
                ? `[Self-review of your previous response]\n\n${parts.join(
                  "\n\n"
                )}\n\nApply these improvements naturally in your next response.`
                : `[Self-review of your previous response]\n\nYour previous response was good. No changes needed.`,
            },
          ]);
        })()
      );
    },
    // #endregion

    // #region run — just return streamText(), chat.agent handles everything else
    run: async ({ messages, clientData, stopSignal }) => {
      userContext.messageCount++;
      if (clientData?.model) {
        userContext.preferredModel = clientData.model;
      }

      const modelOverride = clientData?.model ?? userContext.preferredModel ?? undefined;
      const useReasoning = useExtendedThinking(modelOverride);

      return streamText({
        ...chat.toStreamTextOptions({
          registry,
          telemetry: clientData?.userId ? { userId: clientData.userId } : undefined,
          tools: chatTools,
        }),
        model: languageModelForChatTurn(modelOverride),
        messages: messages,
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
    // #endregion
  });

// #region Raw task variant — same functionality using composable primitives
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

export const aiChatRaw = chat.customAgent({
  id: "ai-chat-raw",
  run: async (payload: ChatTaskWirePayload, { signal: runSignal }) => {
    let currentPayload = payload;
    const clientData = payload.metadata as { userId: string; model?: string } | undefined;

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

    const currentClientData = (currentPayload.metadata ?? clientData) as
      | { userId: string; model?: string }
      | undefined;

    if (!userContext.userId && currentClientData) {
      await initUserContext(
        currentClientData.userId,
        currentPayload.chatId,
        currentClientData.model
      );
    }

    const stop = chat.createStopSignal();
    const conversation = new chat.MessageAccumulator({
      compaction: {
        shouldCompact: ({ totalTokens }) => (totalTokens ?? 0) > COMPACT_AFTER_TOKENS,
        summarize: async ({ messages: msgs }) => {
          const resolved = await compactionPrompt.resolve({});
          return generateText({
            model: registryLanguageModel(resolved.model, "openai:gpt-4o-mini"),
            ...resolved.toAISDKTelemetry(),
            messages: [...msgs, { role: "user" as const, content: resolved.text }],
          }).then((r) => r.text);
        },
        compactUIMessages: ({ summary }) => [
          {
            id: generateId(),
            role: "assistant" as const,
            parts: [{ type: "text" as const, text: `[Summary]\n\n${summary}` }],
          },
        ],
      },
      pendingMessages: {
        shouldInject: () => true,
        prepare: ({ messages }) => [
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: `[User sent ${messages.length} message(s) while you were working]:\n${messages
                  .map((m) => textFromFirstPart(m))
                  .join("\n")}`,
              },
            ],
          },
        ],
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
      const useReasoning = useExtendedThinking(modelOverride);
      const combinedSignal = AbortSignal.any([runSignal, stop.signal]);

      const steeringSub = chat.messages.on(async (msg) => {
        const lastMsg = msg.messages?.[msg.messages.length - 1];
        if (lastMsg) await conversation.steerAsync(lastMsg);
      });

      const result = streamText({
        ...chat.toStreamTextOptions({ registry }),
        model: languageModelForChatTurn(modelOverride),
        messages: messages,
        tools: {
          inspectEnvironment,
          webFetch,
          deepResearch,
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

      let turnUsage: LanguageModelUsage | undefined;
      try {
        turnUsage = await result.totalUsage;
      } catch {
        /* non-fatal */
      }
      await conversation.compactIfNeeded(turnUsage, {
        chatId: currentPayload.chatId,
        turn,
      });

      await prisma.chat.update({
        where: { id: currentPayload.chatId },
        data: { messages: conversation.uiMessages as unknown as ChatMessagesForWrite },
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

export const aiChatSession = chat
  .withClientData({
    schema: z.object({ userId: z.string(), model: z.string().optional() }),
  })
  .customAgent({
    id: "ai-chat-session",
    run: async (payload: ChatTaskWirePayload, { signal }) => {
      const clientData = payload.metadata as { userId: string; model?: string } | undefined;

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
            model: registryLanguageModel(resolved.model, "openai:gpt-4o-mini"),
            ...resolved.toAISDKTelemetry(),
            messages: [...msgs, { role: "user" as const, content: resolved.text }],
          }).then((r) => r.text);
        },
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
      const useReasoning = useExtendedThinking(modelOverride);

      const result = streamText({
        ...chat.toStreamTextOptions({ registry }),
        model: languageModelForChatTurn(modelOverride),
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

      await prisma.chat.update({
        where: { id: turn.chatId },
        data: { messages: turn.uiMessages as unknown as ChatMessagesForWrite },
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
// #endregion

// ============================================================================
// Hydrated agent — backend is source of truth for message history
// ============================================================================
//
// Demonstrates three features:
//
// 1. `hydrateMessages` — backend loads message history from the DB on every
//    turn instead of trusting the frontend. Prevents fabricated history.
//
// 2. `actionSchema` + `onAction` — typed custom actions (undo, rollback)
//    sent via transport.sendAction(). The agent modifies history via
//    chat.history.*, then the LLM responds to the updated state.
//
// 3. `chat.history` — imperative mutations used inside onAction to
//    implement undo (slice off last exchange) and rollback (truncate to
//    a specific message).
//

export const aiChatHydrated = chat
  .withClientData({
    schema: z.object({ model: z.string().optional(), userId: z.string() }),
  })
  .agent({
    id: "ai-chat-hydrated",
    idleTimeoutInSeconds: 60,

    // Load message history from the database on every turn.
    // The frontend's accumulated messages are ignored — the DB is the
    // single source of truth. New user messages arrive in `incomingMessages`
    // and are appended + persisted before returning.
    hydrateMessages: async ({ chatId, trigger, incomingMessages }) => {
      const record = await prisma.chat.findUnique({ where: { id: chatId } });
      const stored = (record?.messages as unknown as UIMessage[]) ?? [];

      if (trigger === "submit-message" && incomingMessages.length > 0) {
        const newMsg = incomingMessages[incomingMessages.length - 1]!;
        stored.push(newMsg);
        await prisma.chat.update({
          where: { id: chatId },
          data: { messages: stored as unknown as ChatMessagesForWrite },
        });
      }

      return stored;
    },

    // Typed actions the frontend can send via transport.sendAction()
    actionSchema: z.discriminatedUnion("type", [
      z.object({ type: z.literal("undo") }),
      z.object({ type: z.literal("rollback"), targetMessageId: z.string() }),
      z.object({ type: z.literal("remove"), messageId: z.string() }),
      z.object({
        type: z.literal("replace"),
        messageId: z.string(),
        text: z.string(),
      }),
    ]),

    onAction: async ({ action }) => {
      switch (action.type) {
        case "undo":
          // Remove the last user message + assistant response
          chat.history.slice(0, -2);
          break;
        case "rollback":
          // Keep messages up to and including the target
          chat.history.rollbackTo(action.targetMessageId);
          break;
        case "remove":
          chat.history.remove(action.messageId);
          break;
        case "replace":
          // Build a new UIMessage with the updated text
          chat.history.replace(action.messageId, {
            id: action.messageId,
            role: "user" as const,
            parts: [{ type: "text" as const, text: action.text }],
          });
          break;
      }
    },

    onChatStart: async ({ chatId, runId, chatAccessToken, clientData, preloaded }) => {
      if (preloaded) return;
      await initUserContext(clientData.userId, chatId, clientData.model);
      await prisma.chatSession.upsert({
        where: { id: chatId },
        create: { id: chatId, publicAccessToken: chatAccessToken },
        update: { publicAccessToken: chatAccessToken },
      });
    },

    onPreload: async ({ chatId, runId, chatAccessToken, clientData }) => {
      if (!clientData) return;
      await initUserContext(clientData.userId, chatId, clientData.model);
      await prisma.chatSession.upsert({
        where: { id: chatId },
        create: { id: chatId, publicAccessToken: chatAccessToken },
        update: { publicAccessToken: chatAccessToken },
      });
    },

    onTurnComplete: async ({ chatId, uiMessages, runId, chatAccessToken, lastEventId }) => {
      // See aiChat.onTurnComplete — atomic to avoid the resume-replay race.
      await prisma.$transaction([
        prisma.chat.update({
          where: { id: chatId },
          data: { messages: uiMessages as unknown as ChatMessagesForWrite },
        }),
        prisma.chatSession.upsert({
          where: { id: chatId },
          create: { id: chatId, publicAccessToken: chatAccessToken, lastEventId },
          update: { publicAccessToken: chatAccessToken, lastEventId },
        }),
      ]);
    },

    run: async ({ messages, clientData, stopSignal }) => {
      return streamText({
        ...chat.toStreamTextOptions(),
        model: languageModelForChatTurn(
          clientData?.model ?? userContext.preferredModel ?? undefined
        ),
        messages,
        abortSignal: stopSignal,
      });
    },
  });

// ============================================================================
// Upgrade test agent — calls chat.requestUpgrade() after 3 turns
// ============================================================================

export const upgradeTestAgent = chat.agent({
  id: "upgrade-test",
  idleTimeoutInSeconds: 60,
  onTurnStart: async ({ turn, ctx }) => {
    logger.info("Upgrade test turn", { turn, version: ctx.run.version });
    if (turn >= 3) {
      logger.info("Requesting upgrade after 3 turns");
      chat.requestUpgrade();
    }
  },
  run: async ({ messages, signal }) => {
    return streamText({
      model: openai("gpt-4o-mini"),
      system:
        "You are a helpful test assistant. Keep responses short (1-2 sentences). " +
        "Always mention what turn number you think you're on based on the conversation history.",
      messages,
      abortSignal: signal,
    });
  },
});
