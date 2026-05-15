/**
 * chat.headStart first-turn endpoint.
 *
 * The browser transport POSTs first-turn messages here when the
 * `headStart` option is set on `useTriggerChatTransport`. This
 * handler:
 *
 *  1. Creates the chat.agent session and triggers a `handover-prepare`
 *     run (atomic, one round-trip), so the agent boots in parallel.
 *  2. Runs `streamText` step 1 right here in the warm Next.js process
 *     and returns the SSE stream directly to the browser — no waiting
 *     on the agent's cold start.
 *  3. On step 1's tool-call boundary, hands ownership of the durable
 *     session.out stream over to the agent run, which executes tools
 *     and continues from step 2+ (or exits clean for pure-text turns).
 *
 * Subsequent turns bypass this endpoint — the transport hydrates the
 * session PAT from response headers and writes directly to
 * `session.in` for turn 2 onward.
 *
 * The TTFC win: cold-start agent boot (~488ms) + onTurnStart hooks
 * (~316ms) overlap with the LLM TTFB instead of stacking before it,
 * so the user-perceived first chunk arrives ~50% sooner. The agent
 * still owns tool execution and everything after — heavy deps stay
 * where they belong.
 */
import { chat } from "@trigger.dev/sdk/chat-server";
import { streamText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
// ⚠️ Imports MUST come from `chat-tools-schemas` only — see the
// header comment in that file for the bundle-isolation rationale.
// Importing `src/trigger/chat-tools.ts` here would drag E2B,
// turndown, the trigger SDK runtime, etc. into the Next.js bundle
// and defeat the whole point of `chat.headStart`.
import { headStartTools } from "@/lib/chat-tools-schemas";

export const POST = chat.headStart({
  agentId: "ai-chat",
  run: async ({ chat: chatHelper }) => {
    return streamText({
      // `toStreamTextOptions` wires `messages` (converted from
      // UIMessages), `tools`, `stopWhen: stepCountIs(1)`, and the
      // combined `abortSignal`. Customer adds model + system prompt on
      // top — anything else `streamText` accepts is fair game.
      ...chatHelper.toStreamTextOptions({ tools: headStartTools }),
      // Match the agent's default (`DEFAULT_MODEL` in `lib/models.ts`)
      // so step 1 and step 2+ run on the same provider — no jarring
      // tone/style shift mid-turn, and TTFC comparisons stay honest.
      model: anthropic("claude-sonnet-4-6"),
      system:
        "You are a helpful AI assistant. Be concise and friendly. Use the available tools when relevant.",
    });
  },
});
