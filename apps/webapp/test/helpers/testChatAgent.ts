import { chat } from "@trigger.dev/sdk/ai";
import { locals } from "@trigger.dev/core/v3";
import { streamText, type LanguageModel, type UIMessage } from "ai";
import { z } from "zod";

/**
 * The model is injected through locals (an in-process, by-reference value)
 * rather than clientData, because a `MockLanguageModelV3` can't survive the
 * JSON round-trip through the real `.in/append` route. The harness sets this
 * before the run starts.
 */
export const testChatModelLocal = locals.create<LanguageModel>("e2e-test-chat.model");

export type TestChatClientData = { hydrated?: UIMessage[] };

function firstText(m: UIMessage): string {
  const p = m.parts?.[0];
  return p?.type === "text" ? p.text : "";
}

export const testChatAgent = chat
  .withClientData({
    schema: z.custom<TestChatClientData>((v) => v == null || typeof v === "object"),
  })
  .agent({
    id: "e2e-test-chat",

    onValidateMessages: async ({ messages }) => {
      for (const m of messages) {
        if (m.role === "user" && firstText(m).toLowerCase().includes("blocked-word")) {
          throw new Error("Message blocked by content filter");
        }
      }
      return messages;
    },

    hydrateMessages: async ({ clientData, incomingMessages }) => {
      if (!clientData?.hydrated) return incomingMessages;
      const merged = [...clientData.hydrated];
      for (const m of incomingMessages) {
        const idx = merged.findIndex((x) => x.id === m.id);
        if (idx === -1) merged.push(m);
        else merged[idx] = m;
      }
      return merged;
    },

    actionSchema: z.discriminatedUnion("type", [z.object({ type: z.literal("undo") })]),

    onAction: async ({ action }) => {
      if (action.type === "undo") {
        chat.history.slice(0, -2);
      }
    },

    run: async ({ messages, signal }) => {
      const model = locals.get(testChatModelLocal);
      if (!model) {
        throw new Error("test model not injected via locals");
      }
      return streamText({ model, messages, abortSignal: signal });
    },
  });
