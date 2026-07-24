import { chat } from "@trigger.dev/sdk/ai";
import { locals, OutOfMemoryError } from "@trigger.dev/core/v3";
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
 * Records suspend/resume lifecycle-hook fires (keyed by chatId so tests can
 * filter to their own session). Appended to by {@link testSuspendHooksChatAgent}.
 */
export const suspendResumeEvents: Array<{
  chatId: string;
  kind: "suspend" | "resume";
  phase: string;
}> = [];

/**
 * Short-idle agent that records `onChatSuspend` / `onChatResume` fires, so a
 * test can assert the lifecycle hooks run around a real suspend/resume.
 */
export const testSuspendHooksChatAgent = chat.agent({
  id: "e2e-test-chat-suspend-hooks",
  idleTimeoutInSeconds: 1,
  preloadIdleTimeoutInSeconds: 1,
  onChatSuspend: async ({ chatId, phase }) => {
    suspendResumeEvents.push({ chatId, kind: "suspend", phase });
  },
  onChatResume: async ({ chatId, phase }) => {
    suspendResumeEvents.push({ chatId, kind: "resume", phase });
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
 * Throws `OutOfMemoryError` on the first attempt so the run fails the way the
 * runtime detects for a machine swap, then succeeds on attempt 2 (the retry
 * boots through the restore path because `ctx.attempt.number > 1`).
 */
export const testOomChatAgent = chat.agent({
  id: "e2e-test-chat-oom",
  idleTimeoutInSeconds: 1,
  preloadIdleTimeoutInSeconds: 1,
  run: async ({ messages, signal, ctx }) => {
    if (ctx.attempt.number === 1) {
      throw new OutOfMemoryError();
    }
    const model = locals.get(testChatModelLocal);
    if (!model) {
      throw new Error("test model not injected via locals");
    }
    return streamText({ model, messages, abortSignal: signal });
  },
});

/**
 * Short idle window and a short `turnTimeout`, so a run with no incoming
 * message suspends and then times out on the waitpoint, ending the run.
 */
export const testTimeoutChatAgent = chat.agent({
  id: "e2e-test-chat-timeout",
  idleTimeoutInSeconds: 1,
  preloadIdleTimeoutInSeconds: 1,
  turnTimeout: "3s",
  preloadTimeout: "3s",
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
 * A plain agent with a 1-second idle window, so the turn loop falls through to
 * the suspending `session.in.wait()` almost immediately instead of catching the
 * next message in the warm once() window. Used to exercise the suspend/resume
 * waitpoint path.
 */
export const testIdleChatAgent = chat.agent({
  id: "e2e-test-chat-idle",
  idleTimeoutInSeconds: 1,
  preloadIdleTimeoutInSeconds: 1,
  run: async ({ messages, signal }) => {
    const model = locals.get(testChatModelLocal);
    if (!model) {
      throw new Error("test model not injected via locals");
    }
    return streamText({ model, messages, abortSignal: signal });
  },
});

/**
 * Ends the run after every turn via `chat.endRun()`. The next message on the
 * same chat starts a fresh continuation run (the orchestrator drives that).
 */
export const testEndRunChatAgent = chat.agent({
  id: "e2e-test-chat-endrun",
  idleTimeoutInSeconds: 2,
  preloadIdleTimeoutInSeconds: 2,
  run: async ({ messages, signal }) => {
    const model = locals.get(testChatModelLocal);
    if (!model) {
      throw new Error("test model not injected via locals");
    }
    const result = streamText({ model, messages, abortSignal: signal });
    chat.endRun();
    return result;
  },
});

/**
 * Requests an upgrade from `onTurnStart` (the pre-turn path): `run()` is
 * skipped, an `upgrade-required` control record lands on `.out`, and the run
 * exits so a fresh run on the new version handles the message.
 */
export const testUpgradeChatAgent = chat.agent({
  id: "e2e-test-chat-upgrade",
  idleTimeoutInSeconds: 2,
  preloadIdleTimeoutInSeconds: 2,
  onTurnStart: async () => {
    chat.requestUpgrade();
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
 * Requests an upgrade only on the fresh (non-continuation) run. The first run
 * defers the message via `upgrade-required`; the continuation run treats it as
 * the "new version" and processes the deferred message instead of upgrading
 * again (which would loop).
 */
export const testUpgradeOnceChatAgent = chat.agent({
  id: "e2e-test-chat-upgrade-once",
  idleTimeoutInSeconds: 2,
  preloadIdleTimeoutInSeconds: 2,
  onTurnStart: async ({ continuation }) => {
    if (!continuation) {
      chat.requestUpgrade();
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

/**
 * Same HITL tool but with a 1-second idle window, so the run suspends on the
 * waitpoint while waiting for the human's tool answer. Exercises a HITL
 * round-trip that crosses a suspend/resume boundary.
 */
export const testHitlIdleChatAgent = chat.agent({
  id: "e2e-test-chat-hitl-idle",
  idleTimeoutInSeconds: 1,
  preloadIdleTimeoutInSeconds: 1,
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

/**
 * A tool that both executes and requires approval. The model's call parks on
 * an approval request; the client approves (or denies) before the `execute`
 * runs.
 */
const deleteResourceTool = tool({
  description: "Delete a resource. Requires human approval before running.",
  inputSchema: z.object({ resource: z.string() }),
  needsApproval: true,
  execute: async ({ resource }) => ({ deleted: resource }),
});

export const testApprovalChatAgent = chat.agent({
  id: "e2e-test-chat-approval",
  run: async ({ messages, signal }) => {
    const model = locals.get(testChatModelLocal);
    if (!model) {
      throw new Error("test model not injected via locals");
    }
    return streamText({
      model,
      messages,
      tools: { deleteResource: deleteResourceTool },
      stopWhen: stepCountIs(5),
      abortSignal: signal,
    });
  },
});
