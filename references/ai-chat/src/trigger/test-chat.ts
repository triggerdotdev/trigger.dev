// A focused chat.agent built for offline testing.
//
// Real agents (aiChat, aiChatHydrated, etc.) depend on Prisma, the OpenAI
// provider registry, prompts, and the deployed environment. Those are
// integration concerns. For unit tests we want a minimal agent that
// exercises the turn loop + hooks without external dependencies.
//
// The model is pulled from clientData so tests can inject a MockLanguageModelV3.

import { chat } from "@trigger.dev/sdk/ai";
import { streamText, type LanguageModel, type UIMessage } from "ai";
import { z } from "zod";

type TestClientData = {
  /** The language model to use for this turn. Tests inject MockLanguageModelV3 here. */
  model: LanguageModel;
  /** Optional pre-seeded messages returned by hydrateMessages. If absent, we use whatever the frontend sent. */
  hydrated?: UIMessage[];
};

function textFromFirstPart(message: UIMessage): string {
  const p = message.parts?.[0];
  return p?.type === "text" ? p.text : "";
}

export const testChatAgent = chat
  .withClientData({
    schema: z.custom<TestClientData>((v) => !!v && typeof v === "object" && "model" in (v as object)),
  })
  .agent({
    id: "test-chat",

    // Validate messages: reject anything that looks like profanity.
    // A realistic content-filter example.
    onValidateMessages: async ({ messages }) => {
      for (const m of messages) {
        if (m.role === "user") {
          const text = textFromFirstPart(m).toLowerCase();
          if (text.includes("blocked-word")) {
            throw new Error("Message blocked by content filter");
          }
        }
      }
      return messages;
    },

    // Hydrate from clientData if provided — simulates loading from DB.
    hydrateMessages: async ({ clientData, incomingMessages }) => {
      if (clientData?.hydrated) {
        return clientData.hydrated;
      }
      return incomingMessages;
    },

    // Custom actions: undo and rollback.
    actionSchema: z.discriminatedUnion("type", [
      z.object({ type: z.literal("undo") }),
      z.object({ type: z.literal("rollback"), targetMessageId: z.string() }),
    ]),

    onAction: async ({ action }) => {
      if (action.type === "undo") {
        // Slice off the last exchange (user + assistant)
        chat.history.slice(0, -2);
      } else if (action.type === "rollback") {
        chat.history.rollbackTo(action.targetMessageId);
      }
    },

    run: async ({ messages, clientData, signal }) => {
      return streamText({
        model: clientData?.model ?? "openai/gpt-4o-mini",
        messages,
        abortSignal: signal,
      });
    },
  });
