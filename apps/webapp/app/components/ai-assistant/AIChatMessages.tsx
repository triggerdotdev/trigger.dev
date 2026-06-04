import {
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
  ShieldExclamationIcon,
  SparklesIcon,
  XCircleIcon,
} from "@heroicons/react/20/solid";
import { useNavigate } from "@remix-run/react";
import { useCallback, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { UIMessage } from "ai";
import { useAutoScrollToBottom } from "~/hooks/useAutoScrollToBottom";
import { Button } from "~/components/primitives/Buttons";
import { toolLabels } from "~/lib/ai-assistant/tool-schemas";
import { AIChatToolCall } from "./AIChatToolCall";
import type { ApiOperationsMap } from "./AIChatProvider";
import { ScrollEdgeFade, useScrollFades } from "./ScrollFade";

interface AIChatMessagesProps {
  messages: UIMessage[];
  status: string;
  error: Error | undefined;
  onRetry: () => void;
  onApprove: (approvalId: string) => void;
  onDeny: (approvalId: string) => void;
  apiOperations: ApiOperationsMap;
}

// User has scrolled this many px up from the bottom before the
// "scroll to bottom" affordance appears.
const SCROLL_BUTTON_THRESHOLD_PX = 100;

export function AIChatMessages({
  messages,
  status,
  error,
  onRetry,
  onApprove,
  onDeny,
  apiOperations,
}: AIChatMessagesProps) {
  const navigate = useNavigate();
  const autoScrollRef = useAutoScrollToBottom([messages]);
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const { ref: fadeRef, onScroll: onFadeScroll, fades } = useScrollFades({
    axis: "vertical",
    deps: [messages, status],
  });

  // The scroll container drives the "new messages" button, the auto-scroll, and
  // the top/bottom edge fades — fan the ref + scroll event out to all of them.
  const setScrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      setScrollContainer(node);
      fadeRef(node);
    },
    [fadeRef]
  );

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
      <ScrollEdgeFade edge="top" visible={fades.start} />
      <div
        ref={setScrollRef}
        onScroll={() => {
          handleScroll();
          onFadeScroll();
        }}
        className="flex-1 overflow-y-auto px-3 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
      >
        <div ref={autoScrollRef}>
          {messages.map((message) => (
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
                        approval?: { id: string; approved?: boolean };
                      };
                      const toolName =
                        part.type === "dynamic-tool"
                          ? toolPart.toolName ?? "tool"
                          : part.type.slice("tool-".length);

                      // The agent is asking the user to approve a state-changing
                      // (or secret-revealing) action before it runs.
                      if (toolPart.state === "approval-requested" && toolPart.approval?.id) {
                        const intent = (toolPart.input as { intent?: string })?.intent;
                        return (
                          <ApprovalCard
                            key={i}
                            approvalId={toolPart.approval.id}
                            intent={intent}
                            input={toolPart.input}
                            apiOperations={apiOperations}
                            onApprove={onApprove}
                            onDeny={onDeny}
                          />
                        );
                      }

                      // The user has answered. If denied, this is terminal; if
                      // approved, the call runs and the part becomes output-available.
                      if (toolPart.state === "approval-responded") {
                        return <ApprovalStatus key={i} approved={!!toolPart.approval?.approved} />;
                      }

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
                              <ToolResultCard
                                toolName={toolName}
                                input={toolPart.input}
                                output={toolPart.output}
                              />
                              <button
                                type="button"
                                onClick={() => navigate(url)}
                                className="group flex w-full items-center gap-2.5 rounded-md border border-grid-bright bg-charcoal-800/40 px-3 py-2 text-left transition-colors animate-in fade-in slide-in-from-bottom-1 duration-150 hover:border-indigo-500/50 hover:bg-charcoal-800/60"
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

                      // Every other completed tool call renders as a collapsed
                      // step the user can expand to inspect its input and output.
                      if (toolPart.state === "output-available") {
                        return (
                          <ToolResultCard
                            key={i}
                            toolName={toolName}
                            input={toolPart.input}
                            output={toolPart.output}
                          />
                        );
                      }

                      return null;
                    }
                    return null;
                  })}
                </div>
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

      <ScrollEdgeFade edge="bottom" visible={fades.end} />

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

// A completed agent step: the tool's friendly name, expandable to reveal the
// exact input it was called with and the output it returned.
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
  const label = toolLabels[toolName] || `Ran ${toolName}`;

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
        <div className="ml-4 mt-2 space-y-2 text-xs">
          {input != null && (
            <div>
              <div className="mb-1 text-text-dimmed">Input:</div>
              <pre className="max-h-48 overflow-auto rounded bg-charcoal-900 p-2 text-xs text-text-dimmed">
                {JSON.stringify(input, null, 2)}
              </pre>
            </div>
          )}
          {output != null && (
            <div>
              <div className="mb-1 text-text-dimmed">Output:</div>
              <pre className="max-h-48 overflow-auto rounded bg-charcoal-900 p-2 text-xs text-text-dimmed">
                {JSON.stringify(output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const METHOD_BADGE_COLORS: Record<string, string> = {
  GET: "bg-green-500/15 text-green-300",
  POST: "bg-indigo-500/15 text-indigo-300",
  PUT: "bg-amber-500/15 text-amber-300",
  PATCH: "bg-amber-500/15 text-amber-300",
  DELETE: "bg-rose-500/15 text-rose-300",
};

function MethodBadge({ method }: { method: string }) {
  const color = METHOD_BADGE_COLORS[method.toUpperCase()] ?? "bg-charcoal-700 text-text-dimmed";
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide ${color}`}
    >
      {method}
    </span>
  );
}

// Operations whose names signal a destructive (vs. merely state-changing)
// action — these get a more alarming treatment than a create/update.
const DESTRUCTIVE_INTENT_HINTS = [
  "delete",
  "cancel",
  "deactivate",
  "pause",
  "reset",
  "remove",
  "promote",
];

// An action the agent wants to take that changes state (or reveals a secret).
// The user must approve before it runs. The `intent` sentence comes straight
// from the model; we fall back to the operationId if it's missing.
function ApprovalCard({
  approvalId,
  intent,
  input,
  apiOperations,
  onApprove,
  onDeny,
}: {
  approvalId: string;
  intent: string | undefined;
  input: unknown;
  apiOperations: ApiOperationsMap;
  onApprove: (approvalId: string) => void;
  onDeny: (approvalId: string) => void;
}) {
  const [decided, setDecided] = useState(false);
  const [showRequest, setShowRequest] = useState(false);
  const operationId = (input as { operationId?: string })?.operationId;
  const params = (input as { params?: unknown })?.params;
  const op = operationId ? apiOperations[operationId] : undefined;
  const description = intent?.trim() || (operationId ? `Run ${operationId}.` : "Perform this action.");
  const isDestructive =
    !!operationId &&
    DESTRUCTIVE_INTENT_HINTS.some((hint) => operationId.toLowerCase().includes(hint));
  const pathFade = useScrollFades({
    axis: "horizontal",
    enabled: showRequest,
    deps: [op?.path, operationId],
  });

  const accent = isDestructive
    ? { border: "border-rose-500/40", bg: "bg-rose-500/[0.06]", icon: "text-rose-400", label: "text-rose-300" }
    : { border: "border-amber-500/40", bg: "bg-amber-500/[0.06]", icon: "text-amber-400", label: "text-amber-300" };

  return (
    <div
      className={`my-1 space-y-3 rounded-md border ${accent.border} ${accent.bg} px-3 py-3 animate-in fade-in slide-in-from-bottom-1 duration-150`}
    >
      <div className="flex items-start gap-2">
        <ShieldExclamationIcon className={`mt-0.5 size-4 shrink-0 ${accent.icon}`} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className={`text-xs font-medium ${accent.label}`}>Approval required</span>
          <span className="text-sm text-text-bright">{description}</span>
        </div>
      </div>

      {operationId && (
        <div>
          <button
            type="button"
            onClick={() => setShowRequest((v) => !v)}
            className="group inline-flex items-center gap-1.5 text-xs text-text-dimmed transition-colors hover:text-text-bright"
          >
            {showRequest ? (
              <ChevronDownIcon className="size-3.5 shrink-0" />
            ) : (
              <ChevronRightIcon className="size-3.5 shrink-0" />
            )}
            View request
          </button>
          {showRequest && (
            <div className="mt-1.5 overflow-hidden rounded border border-grid-bright">
              <div className="flex items-center gap-2 border-b border-grid-bright bg-charcoal-800 px-2 py-1.5">
                <MethodBadge method={op?.method ?? "CALL"} />
                <div className="relative min-w-0 flex-1">
                  <div
                    ref={pathFade.ref}
                    onScroll={pathFade.onScroll}
                    className="overflow-x-auto whitespace-nowrap font-mono text-xs text-text-dimmed scrollbar-hide"
                  >
                    {op?.path ?? operationId}
                  </div>
                  <ScrollEdgeFade edge="left" visible={pathFade.fades.start} tone="code" />
                  <ScrollEdgeFade edge="right" visible={pathFade.fades.end} tone="code" />
                </div>
              </div>
              {params != null && (
                <pre className="max-h-48 overflow-auto bg-charcoal-900 p-2 text-xs text-text-dimmed">
                  {JSON.stringify(params, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="minimal/small"
          disabled={decided}
          onClick={() => {
            setDecided(true);
            onDeny(approvalId);
          }}
        >
          Cancel
        </Button>
        <Button
          variant={isDestructive ? "danger/small" : "primary/small"}
          disabled={decided}
          onClick={() => {
            setDecided(true);
            onApprove(approvalId);
          }}
        >
          Approve
        </Button>
      </div>
    </div>
  );
}

// Shown once the user has answered an approval prompt. Approved calls then run
// (and render their result); denied calls stop here.
function ApprovalStatus({ approved }: { approved: boolean }) {
  return (
    <div className="my-1 flex items-center gap-1.5 text-xs">
      {approved ? (
        <>
          <CheckCircleIcon className="size-3.5 shrink-0 text-green-400" />
          <span className="text-text-dimmed">Approved — running…</span>
        </>
      ) : (
        <>
          <XCircleIcon className="size-3.5 shrink-0 text-text-dimmed" />
          <span className="text-text-dimmed">Cancelled — no changes made</span>
        </>
      )}
    </div>
  );
}
