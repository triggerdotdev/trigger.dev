import {
  ArrowTopRightOnSquareIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
  HandThumbDownIcon,
  HandThumbUpIcon,
  SparklesIcon,
} from "@heroicons/react/20/solid";
import { useNavigate } from "@remix-run/react";
import { motion } from "framer-motion";
import { useState, useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { UIMessage } from "ai";
import { useAutoScrollToBottom } from "~/hooks/useAutoScrollToBottom";
import { AIChatToolCall } from "./AIChatToolCall";
import { FailureSummaryCard, FilterChips, MiniTable } from "./AIChatToolResults";
import { toolLabels } from "~/lib/ai-assistant/tool-schemas";
import { useAIChat } from "./AIChatProvider";

interface AIChatMessagesProps {
  messages: UIMessage[];
  status: string;
  error: Error | undefined;
  onRetry: () => void;
  onSendMessage?: (text: string) => void;
}

// User has scrolled this many px up from the bottom before the
// "scroll to bottom" affordance appears.
const SCROLL_BUTTON_THRESHOLD_PX = 100;

export function AIChatMessages({
  messages,
  status,
  error,
  onRetry,
  onSendMessage,
}: AIChatMessagesProps) {
  const navigate = useNavigate();
  const { requestTestFill } = useAIChat();
  const autoScrollRef = useAutoScrollToBottom([messages]);
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const navigatedMessagesRef = useRef(new Set<string>());
  const prevMessagesLengthRef = useRef(0);

  const isStreaming = status === "streaming" || status === "submitted";

  // Auto-navigate only during live chat, not on history load
  useEffect(() => {
    // Only check for navigation during active streaming
    if (!isStreaming) return;

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") return;

    lastMessage.parts.forEach((part, idx) => {
      const toolPart = part as any;
      if (toolPart.type === "dynamic-tool" || toolPart.type.startsWith("tool-")) {
        const toolName =
          toolPart.type === "dynamic-tool"
            ? toolPart.toolName ?? "tool"
            : toolPart.type.slice("tool-".length);

        if (toolName === "navigateToPage" && toolPart.state === "output-available") {
          const key = `${lastMessage.id}-${idx}`;
          if (!navigatedMessagesRef.current.has(key)) {
            const result = toolPart.output as {
              found: boolean;
              url?: string;
            };
            if (result?.found && result.url) {
              navigatedMessagesRef.current.add(key);
              navigate(result.url);
            }
          }
        }

        // Fill the Test page editor with a generated payload (the Test page for
        // the matching task consumes it). Fire-and-forget; not deduped per-key
        // because re-applying the same payload is harmless.
        if (toolName === "generateTestPayload" && toolPart.state === "output-available") {
          const key = `${lastMessage.id}-${idx}`;
          if (!navigatedMessagesRef.current.has(key)) {
            const result = toolPart.output as {
              success?: boolean;
              taskIdentifier?: string;
              payload?: string;
            };
            if (result?.success && result.taskIdentifier && result.payload) {
              navigatedMessagesRef.current.add(key);
              requestTestFill({ taskIdentifier: result.taskIdentifier, payload: result.payload });
            }
          }
        }

        // Navigate to the run that runTestTask just triggered so the user can watch it.
        if (toolName === "runTestTask" && toolPart.state === "output-available") {
          const key = `${lastMessage.id}-${idx}`;
          if (!navigatedMessagesRef.current.has(key)) {
            const result = toolPart.output as { success?: boolean; url?: string };
            if (result?.success && result.url) {
              navigatedMessagesRef.current.add(key);
              navigate(result.url);
            }
          }
        }
      }
    });
  }, [messages, status, navigate, requestTestFill, isStreaming]);

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
                        input?: unknown;
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
                            <div key={i} className="space-y-2">
                              <ToolResultCard toolName={toolName} input={toolPart.input} output={toolPart.output} />
                              <button
                                type="button"
                                onClick={() => navigate(url)}
                                className="group w-full flex items-center gap-2.5 rounded-md border border-grid-bright bg-charcoal-800/40 px-3 py-2 text-left transition-colors animate-in fade-in slide-in-from-bottom-1 duration-150 hover:border-indigo-500/50 hover:bg-charcoal-800/60"
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
                            </div>
                          );
                        }
                      }

                      // Render structured outputs as rich cards, falling back
                      // to a collapsible JSON view for everything else.
                      if (toolPart.state === "output-available") {
                        return (
                          <ToolOutput
                            key={i}
                            toolName={toolName}
                            input={toolPart.input}
                            output={toolPart.output}
                            onSendMessage={onSendMessage}
                          />
                        );
                      }

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

// Dispatches a completed tool result to its specialized renderer, falling back
// to a collapsible JSON card when there's no dedicated view (or the tool errored).
function ToolOutput({
  toolName,
  input,
  output,
  onSendMessage,
}: {
  toolName: string;
  input: unknown;
  output: unknown;
  onSendMessage?: (text: string) => void;
}) {
  const result = output as Record<string, unknown> | undefined;

  if (toolName === "classifyFailure" && result?.category) {
    return (
      <FailureSummaryCard
        result={result as any}
        runFriendlyId={(input as { runFriendlyId?: string })?.runFriendlyId}
        onSendMessage={onSendMessage}
      />
    );
  }

  if (toolName === "applyRunFilters" && result?.success && result.filters) {
    return <FilterChips filters={result.filters as any} />;
  }

  if (toolName === "listRuns" && Array.isArray(result?.runs) && result.runs.length > 0) {
    const runs = result.runs as Array<{ id: string; status?: string; duration?: string }>;
    const columns = ["Run", "Status", "Duration"];
    const rows = runs.map((r) => [r.id, friendlyStatus(r.status), r.duration ?? "—"]);
    return <MiniTable columns={columns} rows={rows} />;
  }

  if (toolName === "aggregateRuns" && Array.isArray(result?.results) && result.results.length > 0) {
    const groupBy = String(result.groupBy ?? "Group");
    const metric = String(result.metric ?? "Value");
    const columns = [capitalize(groupBy), capitalize(metric)];
    const rows = (result.results as Array<{ dimension: unknown; value: unknown }>).map((r) => [
      r.dimension,
      r.value,
    ]);
    return <MiniTable columns={columns} rows={rows} />;
  }

  if (toolName === "queryRuns" && result?.success && Array.isArray(result.results) && result.results.length > 0) {
    const data = result.results as Array<Record<string, unknown>>;
    const columns = Object.keys(data[0]);
    const rows = data.map((row) => columns.map((c) => row[c]));
    return <MiniTable columns={columns} rows={rows} />;
  }

  if (toolName === "listTestableTasks" && Array.isArray(result?.tasks) && result.tasks.length > 0) {
    const tasks = result.tasks as Array<{ taskIdentifier: string; triggerSource?: string }>;
    const columns = ["Task", "Type"];
    const rows = tasks.map((t) => [t.taskIdentifier, friendlyStatus(t.triggerSource)]);
    return <MiniTable columns={columns} rows={rows} />;
  }

  if (toolName === "generateTestPayload" && result?.success && typeof result.payload === "string") {
    return <GeneratedPayloadCard payload={result.payload} />;
  }

  if (toolName === "runTestTask" && result?.success && result.runId) {
    return (
      <TestRunCard
        taskIdentifier={String(result.taskIdentifier ?? "")}
        runId={String(result.runId)}
        url={result.url ? String(result.url) : undefined}
      />
    );
  }

  return <ToolResultCard toolName={toolName} input={input} output={output} />;
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function friendlyStatus(status?: string) {
  if (!status) return "—";
  return capitalize(status.replace(/_/g, " ").toLowerCase());
}

function GeneratedPayloadCard({ payload }: { payload: string }) {
  return (
    <div className="my-1 overflow-hidden rounded-md border border-grid-bright bg-charcoal-800/40">
      <div className="flex items-center gap-1.5 border-b border-grid-bright px-3 py-1.5">
        <SparklesIcon className="size-3.5 shrink-0 text-indigo-400" />
        <span className="text-xs text-text-bright">Generated test payload</span>
        <span className="ml-auto text-[10px] text-text-dimmed">filled into the editor</span>
      </div>
      <pre className="max-h-56 overflow-auto bg-charcoal-900 p-2.5 text-xs text-text-dimmed">
        {payload}
      </pre>
    </div>
  );
}

function TestRunCard({
  taskIdentifier,
  runId,
  url,
}: {
  taskIdentifier: string;
  runId: string;
  url?: string;
}) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => url && navigate(url)}
      disabled={!url}
      className="group my-1 flex w-full items-center gap-2.5 rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2 text-left transition-colors animate-in fade-in slide-in-from-bottom-1 duration-150 hover:border-green-500/50 enabled:hover:bg-green-500/10"
    >
      <ArrowTopRightOnSquareIcon className="size-4 shrink-0 text-green-400" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-text-bright group-hover:text-green-300">
          Test run triggered{taskIdentifier ? ` — ${taskIdentifier}` : ""}
        </span>
        <span className="truncate text-xs text-text-dimmed">{runId}</span>
      </span>
    </button>
  );
}

function ToolResultCard({
  toolName,
  input,
  output,
}: {
  toolName: string;
  input: unknown;
  output: unknown;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const label = toolLabels[toolName] || `Running ${toolName}`;

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="group inline-flex items-center gap-1.5 text-xs transition-colors hover:text-indigo-400"
      >
        {isExpanded ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-indigo-400" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-text-dimmed group-hover:text-indigo-400" />
        )}
        <SparklesIcon className="size-3 shrink-0 text-indigo-400" />
        <span className="text-text-bright group-hover:text-indigo-400">{label}</span>
      </button>

      {isExpanded && (
        <div className="mt-2 ml-4 space-y-2 text-xs">
          {input && (
            <div>
              <div className="text-text-dimmed mb-1">Input:</div>
              <pre className="bg-charcoal-900 rounded p-2 overflow-x-auto text-text-dimmed text-xs max-h-48 overflow-y-auto">
                {JSON.stringify(input, null, 2)}
              </pre>
            </div>
          )}
          {output && (
            <div>
              <div className="text-text-dimmed mb-1">Output:</div>
              <pre className="bg-charcoal-900 rounded p-2 overflow-x-auto text-text-dimmed text-xs max-h-48 overflow-y-auto">
                {JSON.stringify(output, null, 2)}
              </pre>
            </div>
          )}
        </div>
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
