"use client";

// The Ask AI conversation and the chat client. Loaded with import() on the first panel open or
// the first Ask from search, so pages don't ship the AI SDK until a reader asks something.

import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { track } from "@/lib/analytics";
import { basePath } from "@/lib/base-path";
import { answerOf, textOf } from "./ask-answer";

type AskSource = "panel" | "search";
let askSource: AskSource = "panel";

/**
 * One conversation shared by the panel and the search dialog, so "Continue in Ask AI" carries an
 * answer over even while it's still streaming.
 */
export const askChat = new Chat({
  transport: new DefaultChatTransport({
    api: `${basePath}/api/ask`,
    // The server answers from the last few turns and refuses over 50 messages, so a long
    // conversation sends only its tail; the panel still shows all of it.
    prepareSendMessagesRequest: ({ messages, body }) => ({
      body: { ...body, messages: messages.slice(-16) },
    }),
  }),
  onFinish: ({ message, messages, isAbort, isError }) =>
    track("docs_ask_ai_answered", {
      question: textOf(messages.findLast((x) => x.role === "user")),
      cited: answerOf(message).cited.map((s) => s.url),
      aborted: isAbort,
      error: isError,
      source: askSource,
    }),
});

/** Sends a question on the shared conversation, with the analytics event. */
export function sendAsk(text: string, opts: { source: AskSource; page?: string; turn: number }) {
  askSource = opts.source;
  track("docs_ask_ai_asked", {
    question: text.trim(),
    page: opts.page,
    turn: opts.turn,
    source: opts.source,
  });
  return askChat.sendMessage({ text }, { body: { page: opts.page } });
}

/** A question from search starts a new conversation. */
export function askFromSearch(text: string) {
  askChat.stop();
  askChat.clearError();
  askChat.messages = [];
  return sendAsk(text, { source: "search", turn: 1 });
}
