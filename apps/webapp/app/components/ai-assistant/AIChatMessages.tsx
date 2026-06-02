import {
  ArrowTopRightOnSquareIcon,
  ChevronDownIcon,
  ExclamationTriangleIcon,
  HandThumbDownIcon,
  HandThumbUpIcon,
} from "@heroicons/react/20/solid";
import { useNavigate } from "@remix-run/react";
import { motion } from "framer-motion";
import { useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { UIMessage } from "ai";
import { useAutoScrollToBottom } from "~/hooks/useAutoScrollToBottom";
import { AIChatToolCall } from "./AIChatToolCall";

interface AIChatMessagesProps {
  messages: UIMessage[];
  status: string;
  error: Error | undefined;
  onRetry: () => void;
}

// User has scrolled this many px up from the bottom before the
// "scroll to bottom" affordance appears.
const SCROLL_BUTTON_THRESHOLD_PX = 100;

export function AIChatMessages({ messages, status, error, onRetry }: AIChatMessagesProps) {
  const navigate = useNavigate();
  const autoScrollRef = useAutoScrollToBottom([messages]);
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const isStreaming = status === "streaming" || status === "submitted";

  // Feedback bar only attaches to the most recent assistant turn.
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  const handleScroll = () => {
    if (!scrollContainer) return;
    const distanceFromBottom =
      scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
    setShowScrollButton(distanceFromBottom > SCROLL_BUTTON_THRESHOLD_PX);
  };

  const scrollToBottom = () => {
    scrollContainer?.scrollTo({ top: scrollContainer.scrollHeight, behavior: "smooth" });
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={setScrollContainer}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
      >
        <div ref={autoScrollRef}>
          {messages.map((message, msgIndex) => (
            <div key={message.id} className="mb-4">
              {message.role === "user" && (
                <div className="py-2 text-sm font-semibold text-text-bright">
                  {message.parts
                    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
                    .map((p, i) => (
                      <span key={i}>{p.text}</span>
                    ))}
                </div>
              )}
              {message.role === "assistant" && (
                <div className="space-y-1">
                  {message.parts.map((part, i) => {
                    if (part.type === "text") {
                      return (
                        <div
                          key={i}
                          className="prose prose-invert prose-sm max-w-none break-words text-text-dimmed prose-headings:text-text-bright prose-a:text-indigo-400 prose-code:text-text-bright prose-pre:overflow-x-auto prose-pre:bg-charcoal-800 prose-pre:text-xs"
                          dangerouslySetInnerHTML={{
                            __html: DOMPurify.sanitize(marked(part.text) as string),
                          }}
                        />
                      );
                    }
                    // AI SDK v6 tool parts: `tool-${name}` (typed) or "dynamic-tool".
                    if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
                      const toolPart = part as {
                        type: string;
                        state: string;
                        toolName?: string;
                        output?: unknown;
                      };
                      const toolName =
                        part.type === "dynamic-tool"
                          ? toolPart.toolName ?? "tool"
                          : part.type.slice("tool-".length);

                      // Show spinner while the tool input is being produced / called.
                      if (
                        toolPart.state === "input-streaming" ||
                        toolPart.state === "input-available"
                      ) {
                        return (
                          <AIChatToolCall key={i} toolName={toolName} state={toolPart.state} />
                        );
                      }

                      // Render navigation results as a clickable link card.
                      if (toolName === "navigateToPage" && toolPart.state === "output-available") {
                        const result = toolPart.output as {
                          found: boolean;
                          url?: string;
                          pageName?: string;
                          description?: string;
                          message?: string;
                        };
                        if (result?.found && result.url) {
                          const url = result.url;
                          return (
                            <button
                              key={i}
                              type="button"
                              onClick={() => navigate(url)}
                              className="group my-2 flex w-full items-center gap-2.5 rounded-md border border-grid-bright bg-charcoal-800/40 px-3 py-2 text-left transition-colors animate-in fade-in slide-in-from-bottom-1 duration-150 hover:border-indigo-500/50 hover:bg-charcoal-800/60"
                            >
                              <ArrowTopRightOnSquareIcon className="size-4 shrink-0 text-text-dimmed group-hover:text-indigo-400" />
                              <span className="flex min-w-0 flex-col">
                                <span className="truncate text-sm text-text-bright group-hover:text-indigo-400">
                                  {result.pageName}
                                </span>
                                {result.description && (
                                  <span className="text-xs text-text-dimmed">
                                    {result.description}
                                  </span>
                                )}
                              </span>
                            </button>
                          );
                        }
                      }
                      // Other tool results are consumed by the LLM, no UI needed.
                      return null;
                    }
                    return null;
                  })}
                </div>
              )}
              {message.role === "assistant" && msgIndex === lastAssistantIndex && !isStreaming && (
                <FeedbackBar key={message.id} />
              )}
            </div>
          ))}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2.5">
              <ExclamationTriangleIcon className="mt-0.5 size-4 shrink-0 text-rose-400" />
              <div className="flex flex-col">
                <span className="text-sm text-rose-300">
                  {error.message || "Something went wrong. Please try again."}
                </span>
                <button
                  type="button"
                  onClick={onRetry}
                  className="mt-1 w-fit text-xs text-rose-400 underline transition-colors hover:text-rose-300"
                >
                  Try again
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {showScrollButton && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-grid-bright bg-charcoal-700 px-3 py-1.5 shadow-md transition-colors animate-in fade-in slide-in-from-bottom-2 duration-150 hover:bg-charcoal-600"
        >
          <ChevronDownIcon className="size-3.5 text-text-dimmed" />
          <span className="text-xs text-text-dimmed">New messages</span>
        </button>
      )}
    </div>
  );
}

function FeedbackBar() {
  const [submitted, setSubmitted] = useState(false);

  if (submitted) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3 }}
        className="pt-1 text-xs text-text-dimmed"
      >
        Thanks for the feedback
      </motion.div>
    );
  }

  return (
    <div className="flex items-center gap-1 pt-1">
      <button
        type="button"
        onClick={() => setSubmitted(true)}
        title="Good response"
        className="rounded p-1 transition-colors hover:bg-charcoal-700"
      >
        <HandThumbUpIcon className="size-3.5 text-text-dimmed transition-colors hover:text-green-400" />
      </button>
      <button
        type="button"
        onClick={() => setSubmitted(true)}
        title="Bad response"
        className="rounded p-1 transition-colors hover:bg-charcoal-700"
      >
        <HandThumbDownIcon className="size-3.5 text-text-dimmed transition-colors hover:text-rose-400" />
      </button>
    </div>
  );
}
