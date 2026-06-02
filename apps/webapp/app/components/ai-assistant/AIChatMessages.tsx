import { useEffect, useRef } from "react";
import { Link } from "@remix-run/react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { UIMessage } from "ai";
import { AIChatToolCall } from "./AIChatToolCall";

interface AIChatMessagesProps {
  messages: UIMessage[];
}

export function AIChatMessages({ messages }: AIChatMessagesProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
      {messages.map((message) => (
        <div key={message.id} className="mb-4">
          {message.role === "user" && (
            <div className="mb-2 text-sm font-medium text-text-bright">
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
                      className="prose prose-invert max-w-none text-sm text-text-dimmed prose-headings:text-text-bright prose-a:text-indigo-400 prose-code:text-text-bright prose-pre:bg-charcoal-750"
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
                    return <AIChatToolCall key={i} toolName={toolName} state={toolPart.state} />;
                  }

                  // Render navigation results as clickable links.
                  if (toolName === "navigateToPage" && toolPart.state === "output-available") {
                    const result = toolPart.output as {
                      found: boolean;
                      url?: string;
                      pageName?: string;
                      description?: string;
                      message?: string;
                    };
                    if (result?.found && result.url) {
                      return (
                        <div key={i} className="my-2">
                          <Link
                            to={result.url}
                            className="inline-flex items-center gap-1.5 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-3 py-1.5 text-sm text-indigo-400 transition hover:bg-indigo-500/20"
                          >
                            Go to {result.pageName} →
                          </Link>
                        </div>
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
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}