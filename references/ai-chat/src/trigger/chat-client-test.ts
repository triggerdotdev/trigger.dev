/**
 * Test tasks demonstrating the AgentChat and ChatStream APIs
 * for server-side agent interaction.
 */
import { task, logger } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { AgentChat, ChatStream } from "@trigger.dev/sdk/chat";
import type { aiChat, upgradeTestAgent } from "./chat";
import type { prReviewChat } from "./pr-review";

// ─── Example 1: Simple multi-turn conversation ─────────────────────

export const chatClientTest = task({
  id: "chat-client-test",
  run: async (payload: { message: string; followUp?: string }) => {
    const chat = new AgentChat<typeof aiChat>({
      agent: "ai-chat",
      clientData: { userId: "chat-client-test", model: "gpt-4o-mini" },
    });

    await chat.preload();

    // Send and get text back
    const text = await (await chat.sendMessage(payload.message)).text();
    logger.info("Response", { preview: text.slice(0, 200) });

    // Follow-up reuses the same run
    if (payload.followUp) {
      const { text: followUp, toolCalls } = await (await chat.sendMessage(payload.followUp)).result();
      logger.info("Follow-up", {
        preview: followUp.slice(0, 200),
        toolCalls: toolCalls.map((tc) => tc.toolName),
      });
    }

    await chat.close();
    return { chatId: chat.id, text: text.slice(0, 500) };
  },
});

// ─── Example 2: Streaming chunks ───────────────────────────────────

export const streamingTest = task({
  id: "chat-client-streaming-test",
  run: async (payload: { message: string }) => {
    const chat = new AgentChat<typeof aiChat>({
      agent: "ai-chat",
      clientData: { userId: "streaming-test", model: "gpt-4o-mini" },
    });

    await chat.preload();

    const stream = await chat.sendMessage(payload.message);

    let charCount = 0;
    const toolsUsed: string[] = [];

    for await (const chunk of stream) {
      if (chunk.type === "text-delta") {
        charCount += chunk.delta.length;
      }
      if (chunk.type === "tool-input-available") {
        toolsUsed.push(chunk.toolName);
        logger.info("Agent using tool", { tool: chunk.toolName, input: chunk.input });
      }
      if (chunk.type === "tool-output-available") {
        logger.info("Tool output", { toolCallId: chunk.toolCallId });
      }
    }

    await chat.close();
    return { charCount, toolsUsed };
  },
});

// ─── Example 3: PR review agent (typed clientData) ─────────────────

export const prReviewTest = task({
  id: "chat-client-pr-review-test",
  run: async (payload: { prNumber: number }) => {
    const chat = new AgentChat<typeof prReviewChat>({
      agent: "pr-review",
      id: `pr-review-${payload.prNumber}`,
      clientData: {
        userId: "ci-bot",
        githubUrl: "https://github.com/ericallam/definitely-safe-ai",
      },
    });

    await chat.preload();

    const review = await (await chat.sendMessage(`Review PR #${payload.prNumber}`)).result();
    logger.info("Review complete", {
      textLength: review.text.length,
      toolCalls: review.toolCalls.map((tc) => `${tc.toolName}(${JSON.stringify(tc.input)})`),
    });

    const fix = await (
      await chat.sendMessage("Can you suggest a fix for the most critical issue and verify it works?")
    ).result();

    await chat.close();

    return {
      reviewPreview: review.text.slice(0, 500),
      fixPreview: fix.text.slice(0, 500),
      toolsUsed: [
        ...review.toolCalls.map((tc) => tc.toolName),
        ...fix.toolCalls.map((tc) => tc.toolName),
      ],
    };
  },
});

// ─── Example 4: Low-level sendRaw + ChatStream ─────────────────────

export const lowLevelTest = task({
  id: "chat-client-low-level-test",
  run: async (payload: { message: string }) => {
    const chat = new AgentChat<typeof aiChat>({
      agent: "ai-chat",
      clientData: { userId: "low-level-test", model: "gpt-4o-mini" },
    });

    await chat.preload();

    // sendRaw for full control over the UIMessage shape
    const rawStream = await chat.sendRaw([
      {
        id: `msg-${Date.now()}`,
        role: "user",
        parts: [{ type: "text", text: payload.message }],
      },
    ]);

    const stream = new ChatStream(rawStream);
    const { text, toolCalls } = await stream.result();

    await chat.close();
    return { text: text.slice(0, 500), toolCalls: toolCalls.map((tc) => tc.toolName) };
  },
});

// ─── Example 5: Agent-to-agent orchestration ───────────────────────

export const orchestratorTest = task({
  id: "chat-client-orchestrator-test",
  run: async (payload: { topic: string }) => {
    const researcher = new AgentChat<typeof aiChat>({
      agent: "ai-chat",
      clientData: { userId: "orchestrator", model: "gpt-4o-mini" },
    });

    await researcher.preload();

    const research = await (
      await researcher.sendMessage(`Research this topic and summarize key findings: ${payload.topic}`)
    ).text();

    const analysis = await (
      await researcher.sendMessage(
        "Based on your research, what are the top 3 actionable recommendations?"
      )
    ).text();

    await researcher.close();

    return {
      research: research.slice(0, 500),
      analysis: analysis.slice(0, 500),
    };
  },
});

// ─── Example 6: Single-turn sub-agent tool ─────────────────────────

import { tool as aiTool, streamText, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const prReviewTool = aiTool({
  description: "Delegate a PR review to the PR review agent.",
  inputSchema: z.object({
    prNumber: z.number().describe("The PR number to review"),
    repo: z.string().describe("The GitHub repo URL"),
  }),
  execute: async function* ({ prNumber, repo }, { abortSignal }) {
    const chat = new AgentChat<typeof prReviewChat>({
      agent: "pr-review",
      id: `sub-review-${prNumber}`,
      clientData: { userId: "parent-agent", githubUrl: repo },
    });

    await chat.preload();
    const stream = await chat.sendMessage(`Review PR #${prNumber}`, { abortSignal });
    yield* stream.messages();
    await chat.close();
  },
  toModelOutput: ({ output: message }) => {
    const lastText = message?.parts?.findLast(
      (p: { type: string }) => p.type === "text"
    ) as { text?: string } | undefined;
    return { type: "text" as const, value: lastText?.text ?? "Review complete." };
  },
});

// ─── Example 7: Multi-turn sub-agent (LLM-driven, cross-turn) ──────

export const orchestratorAgent = chat
  .withClientData({
    schema: z.object({ userId: z.string() }),
  })
  .customAgent({
    id: "orchestrator-agent",
    run: async (payload, { signal: runSignal }) => {
      let currentPayload: typeof payload = payload;

      // Sub-agent instances live in the run closure — survive across turns
      const subAgents = new Map<string, AgentChat<typeof aiChat>>();

      const researchAgentTool = aiTool({
        description:
          "Talk to a research agent. Use the same conversationId to continue " +
          "an existing conversation — the agent remembers full context.",
        inputSchema: z.object({
          conversationId: z.string().describe("Reuse to continue a conversation."),
          message: z.string().describe("Your message to the research agent"),
        }),
        execute: async function* ({ conversationId, message }, { abortSignal }) {
          let agent = subAgents.get(conversationId);
          if (!agent) {
            agent = new AgentChat<typeof aiChat>({
              agent: "ai-chat",
              id: conversationId,
              clientData: {
                userId: currentPayload.metadata?.userId ?? "orchestrator",
                model: "gpt-4o-mini",
              },
            });
            await agent.preload();
            subAgents.set(conversationId, agent);
          }

          const stream = await agent.sendMessage(message, { abortSignal });
          yield* stream.messages();
        },
        toModelOutput: ({ output: message }) => {
          const lastText = message?.parts?.findLast(
            (p: { type: string }) => p.type === "text"
          ) as { text?: string } | undefined;
          return { type: "text" as const, value: lastText?.text ?? "Research complete." };
        },
      });

      // Preload handling
      if (currentPayload.trigger === "preload") {
        const result = await chat.messages.waitWithIdleTimeout({
          idleTimeoutInSeconds: 120,
          timeout: "1h",
          spanName: "waiting for first message",
        });
        if (!result.ok) return;
        currentPayload = result.output as typeof payload;
      }

      if (currentPayload.trigger === "close") return;

      const stop = chat.createStopSignal();
      const conversation = new chat.MessageAccumulator();

      for (let turn = 0; turn < 50; turn++) {
        stop.reset();

        const messages = await conversation.addIncoming(
          currentPayload.messages,
          currentPayload.trigger,
          turn
        );

        const combinedSignal = AbortSignal.any([runSignal, stop.signal]);

        const result = streamText({
          model: anthropic("claude-sonnet-4-6"),
          system:
            "You are an orchestrator that delegates research to a sub-agent. " +
            "Use the researchAgent tool with a conversationId to start or continue " +
            "a research thread.",
          messages,
          tools: { researchAgent: researchAgentTool },
          stopWhen: stepCountIs(15),
          abortSignal: combinedSignal,
        });

        let response;
        try {
          response = await chat.pipeAndCapture(result, { signal: combinedSignal });
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            if (runSignal.aborted) break;
          } else {
            throw error;
          }
        }

        if (response) {
          if (stop.signal.aborted && !runSignal.aborted) {
            await conversation.addResponse(chat.cleanupAbortedParts(response));
          } else {
            await conversation.addResponse(response);
          }
        }

        if (runSignal.aborted) break;

        await chat.writeTurnComplete();

        const next = await chat.messages.waitWithIdleTimeout({
          idleTimeoutInSeconds: 120,
          timeout: "1h",
          spanName: "waiting for next message",
        });
        if (!next.ok) break;
        currentPayload = next.output as typeof payload;
        if (currentPayload.trigger === "close") break;
      }

      // Cleanup sub-agents
      const closePromises = Array.from(subAgents.values()).map((a) =>
        a.close().catch(() => { })
      );
      await Promise.all(closePromises);

      stop.cleanup();
    },
  });

// ─── Example 8: chat.requestUpgrade() test ────────────────────────

export const upgradeTest = task({
  id: "chat-client-upgrade-test",
  run: async () => {
    const agentChat = new AgentChat<typeof upgradeTestAgent>({
      agent: "upgrade-test",
    });

    const results: { turn: number; text: string; runId?: string }[] = [];

    // Send 6 messages — the agent requests an upgrade after turn 3 (0-indexed),
    // so the run exits after the 4th response. The 5th message triggers a
    // continuation on a new run, and the 6th message continues on that run.
    for (let i = 0; i < 6; i++) {
      const stream = await agentChat.sendMessage(`This is message ${i + 1}. What turn are you on?`);
      const text = await stream.text();

      // If we get an empty response, the run just exited — wait a moment
      // for it to fully complete, then retry (triggers continuation)
      if (text === "" && i > 0) {
        logger.info(`Turn ${i}: empty response, retrying after run completes`);
        await new Promise((r) => setTimeout(r, 2000));
        const retryStream = await agentChat.sendMessage(
          `This is message ${i + 1} (retry). What turn are you on?`
        );
        const retryText = await retryStream.text();
        results.push({
          turn: i,
          text: retryText.slice(0, 200),
          runId: agentChat.id,
        });
        logger.info(`Turn ${i} (retry)`, {
          text: retryText.slice(0, 200),
          runId: agentChat.id,
        });
        continue;
      }

      results.push({
        turn: i,
        text: text.slice(0, 200),
        runId: agentChat.id,
      });
      logger.info(`Turn ${i}`, { text: text.slice(0, 200), runId: agentChat.id });
    }

    await agentChat.close();

    // Check that a continuation happened — runId should change
    const runIds = [...new Set(results.map((r) => r.runId))];
    logger.info("Upgrade test complete", {
      totalTurns: results.length,
      uniqueRuns: runIds.length,
      runIds,
    });

    return {
      turns: results,
      uniqueRuns: runIds.length,
      upgraded: runIds.length > 1,
    };
  },
});
