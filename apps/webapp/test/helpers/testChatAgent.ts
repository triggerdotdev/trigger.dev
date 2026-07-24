import { chat } from "@trigger.dev/sdk/ai";
import { locals } from "@trigger.dev/core/v3";
import { stepCountIs, streamText, tool, type LanguageModel, type UIMessage } from "ai";
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

/**
 * A minimal agent with no lifecycle hooks. With `hydrateMessages` absent, the
 * default snapshot + `.out`/`.in` replay boot path is what restores prior
 * history on a continuation run.
 */
export const testPlainChatAgent = chat.agent({
  id: "e2e-test-chat-plain",
  run: async ({ messages, signal }) => {
    const model = locals.get(testChatModelLocal);
    if (!model) {
      throw new Error("test model not injected via locals");
    }
    return streamText({ model, messages, abortSignal: signal });
  },
});

/**
 * A tool with a server-side `execute`: the agent runs it automatically and
 * feeds the result back to the model, so a single turn covers the whole
 * tool loop.
 */
const weatherTool = tool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 21, summary: "clear" }),
});

export const testToolChatAgent = chat.agent({
  id: "e2e-test-chat-tool",
  run: async ({ messages, signal }) => {
    const model = locals.get(testChatModelLocal);
    if (!model) {
      throw new Error("test model not injected via locals");
    }
    return streamText({
      model,
      messages,
      tools: { getWeather: weatherTool },
      stopWhen: stepCountIs(5),
      abortSignal: signal,
    });
  },
});

/**
 * A tool with no `execute`: the model's call parks the turn on a
 * human-in-the-loop round-trip. The client supplies the tool output on the
 * next message and the agent continues from there.
 */
const askUserTool = tool({
  description: "Ask the user a question and wait for their answer.",
  inputSchema: z.object({ question: z.string() }),
});

export const testHitlChatAgent = chat.agent({
  id: "e2e-test-chat-hitl",
  run: async ({ messages, signal }) => {
    const model = locals.get(testChatModelLocal);
    if (!model) {
      throw new Error("test model not injected via locals");
    }
    return streamText({
      model,
      messages,
      tools: { askUser: askUserTool },
      abortSignal: signal,
    });
  },
});
