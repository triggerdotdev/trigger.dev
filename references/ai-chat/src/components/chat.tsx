"use client";

import { useChat } from "@ai-sdk/react";
import {
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import type { ChatUiMessage } from "@/lib/chat-tools";
import type { TriggerChatTransport } from "@trigger.dev/sdk/chat";
import type { CompactionChunkData } from "@trigger.dev/sdk/ai";
import { usePendingMessages } from "@trigger.dev/sdk/chat/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { MODEL_OPTIONS } from "@/lib/models";

function ToolInvocation({
  part,
  onApprove,
  onDeny,
  onToolOutput,
}: {
  part: any;
  onApprove?: (approvalId: string) => void;
  onDeny?: (approvalId: string) => void;
  onToolOutput?: (toolCallId: string, output: unknown) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const toolName = part.type.startsWith("tool-") ? part.type.slice(5) : "tool";
  const state = part.state ?? "input-available";
  const args = part.input;
  const result = part.output;

  const isLoading = state === "input-streaming" || state === "input-available";
  const isError = state === "output-error";
  const needsApproval = state === "approval-requested";
  const wasApproved = state === "approval-responded" && part.approval?.approved === true;
  const wasDenied = state === "approval-responded" && part.approval?.approved === false;

  return (
    <div className="my-1 rounded border border-gray-200 bg-gray-50 text-xs">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-medium text-gray-700 hover:bg-gray-100"
      >
        {isLoading && (
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
        )}
        {needsApproval && <span className="text-amber-500">&#9888;</span>}
        {wasApproved && <span className="text-green-600">&#10003;</span>}
        {wasDenied && <span className="text-red-600">&#10007;</span>}
        {!isLoading && !needsApproval && !wasApproved && !wasDenied && !isError && (
          <span className="text-green-600">&#10003;</span>
        )}
        {isError && <span className="text-red-600">&#10007;</span>}
        <span>{toolName}</span>
        {needsApproval && <span className="text-amber-500 text-[10px]">needs approval</span>}
        <span className="ml-auto text-gray-400">{expanded ? "▲" : "▼"}</span>
      </button>

      {needsApproval && (
        <div className="flex gap-2 border-t border-gray-200 px-3 py-2">
          <button
            type="button"
            onClick={() => onApprove?.(part.approval.id)}
            className="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => onDeny?.(part.approval.id)}
            className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
          >
            Deny
          </button>
        </div>
      )}

      {/* askUser tool: show question + option buttons when input-available */}
      {toolName === "askUser" && state === "input-available" && args?.question && (
        <div className="border-t border-gray-200 px-3 py-2 space-y-2">
          <div className="font-medium text-gray-700">{args.question}</div>
          <div className="flex flex-wrap gap-2">
            {(args.options ?? []).map((opt: any) => (
              <button
                key={opt.id}
                type="button"
                onClick={() =>
                  onToolOutput?.(part.toolCallId, {
                    skipped: false,
                    answers: [{ questionId: args.question, optionId: opt.id, text: opt.label }],
                  })
                }
                className="rounded border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs text-blue-700 hover:bg-blue-100"
                title={opt.description}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {expanded && (
        <div className="border-t border-gray-200 px-3 py-2 space-y-2">
          {args && Object.keys(args).length > 0 && (
            <div>
              <div className="mb-1 font-medium text-gray-500">Input</div>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-white p-2 text-gray-800">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {state === "output-available" && result !== undefined && (
            <div>
              <div className="mb-1 font-medium text-gray-500">Output</div>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-white p-2 text-gray-800">
                {JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
          {isError && result !== undefined && (
            <div>
              <div className="mb-1 font-medium text-red-500">Error</div>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-red-50 p-2 text-red-700">
                {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResearchProgress({ part }: { part: any }) {
  const data = part.data as {
    status: "fetching" | "done";
    query: string;
    current: number;
    total: number;
    currentUrl?: string;
    completedUrls: string[];
  };

  const isDone = data.status === "done";

  return (
    <div className="my-2 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs">
      <div className="flex items-center gap-2 font-medium text-blue-700">
        {isDone ? (
          <span className="text-green-600">&#10003;</span>
        ) : (
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
        )}
        <span>
          {isDone
            ? `Research complete — ${data.total} sources fetched`
            : `Researching "${data.query}" (${data.current}/${data.total})`}
        </span>
      </div>
      {data.currentUrl && !isDone && (
        <div className="mt-1 truncate text-blue-500">Fetching {data.currentUrl}</div>
      )}
      {data.completedUrls.length > 0 && (
        <div className="mt-1 space-y-0.5 text-blue-400">
          {data.completedUrls.map((url, i) => (
            <div key={i} className="truncate">
              &#10003; {url}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type TtfbEntry = { turn: number; ttfbMs: number };

function DebugPanel({
  chatId,
  model,
  status,
  session,
  dashboardUrl,
  messageCount,
  ttfbHistory,
}: {
  chatId: string;
  model: string;
  status: string;
  session?: { runId: string; publicAccessToken: string; lastEventId?: string };
  dashboardUrl?: string;
  messageCount: number;
  ttfbHistory: TtfbEntry[];
}) {
  const [open, setOpen] = useState(false);

  const runUrl =
    session?.runId && dashboardUrl ? `${dashboardUrl}/runs/${session.runId}` : undefined;

  const latestTtfb = ttfbHistory.length > 0 ? ttfbHistory[ttfbHistory.length - 1]! : undefined;
  const avgTtfb =
    ttfbHistory.length > 0
      ? Math.round(ttfbHistory.reduce((sum, e) => sum + e.ttfbMs, 0) / ttfbHistory.length)
      : undefined;

  return (
    <div className="shrink-0 border-t border-gray-200 bg-gray-50 text-xs text-gray-500">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-4 py-1.5 hover:bg-gray-100"
      >
        <span className="font-medium">Debug</span>
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            status === "streaming"
              ? "bg-green-500"
              : session?.runId
              ? "bg-yellow-500"
              : "bg-gray-300"
          }`}
        />
        <span>{status}</span>
        {latestTtfb && (
          <span className="font-mono text-blue-600">
            TTFB {latestTtfb.ttfbMs.toLocaleString()}ms
          </span>
        )}
        {session?.runId && <span className="font-mono">{session.runId}</span>}
        <span className="ml-auto text-gray-400">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="border-t border-gray-200 px-4 py-2 space-y-1">
          <Row label="Chat ID" value={chatId} mono />
          <Row label="Model" value={model} />
          <Row label="Status" value={status} />
          <Row label="Messages" value={String(messageCount)} />
          {session ? (
            <>
              <Row label="Run ID" value={session.runId} mono link={runUrl} />
              <Row label="Last Event ID" value={session.lastEventId ?? "—"} mono />
            </>
          ) : (
            <Row label="Session" value="none" />
          )}
          {ttfbHistory.length > 0 && (
            <>
              <div className="mt-2 border-t border-gray-200 pt-2">
                <span className="font-medium text-gray-600">TTFB</span>
                {avgTtfb !== undefined && (
                  <span className="ml-2 text-gray-400">avg {avgTtfb.toLocaleString()}ms</span>
                )}
              </div>
              {ttfbHistory.map((entry) => (
                <div key={entry.turn} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-gray-400">Turn {entry.turn}</span>
                  <span className="font-mono">{entry.ttfbMs.toLocaleString()}ms</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  link,
}: {
  label: string;
  value: string;
  mono?: boolean;
  link?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-gray-400">{label}</span>
      {link ? (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className={`truncate text-blue-600 underline ${mono ? "font-mono" : ""}`}
        >
          {value}
        </a>
      ) : (
        <span className={`truncate ${mono ? "font-mono" : ""}`}>{value}</span>
      )}
    </div>
  );
}

type ChatProps = {
  chatId: string;
  initialMessages: ChatUiMessage[];
  transport: TriggerChatTransport;
  resume?: boolean;
  model: string;
  isNewChat: boolean;
  onModelChange?: (model: string) => void;
  session?: { runId: string; publicAccessToken: string; lastEventId?: string };
  dashboardUrl?: string;
  onFirstMessage?: (chatId: string, text: string) => void;
  onMessagesChange?: (chatId: string, messages: ChatUiMessage[]) => void;
};

export function Chat({
  chatId,
  initialMessages,
  transport,
  resume: resumeProp,
  model,
  isNewChat,
  onModelChange,
  session,
  dashboardUrl,
  onFirstMessage,
  onMessagesChange,
}: ChatProps) {
  const [input, setInput] = useState("");
  const hasCalledFirstMessage = useRef(false);

  // TTFB tracking
  const sendTimestamp = useRef<number | null>(null);
  const turnCounter = useRef(0);
  const [ttfbHistory, setTtfbHistory] = useState<TtfbEntry[]>([]);

  const {
    messages,
    setMessages,
    sendMessage,
    stop: aiStop,
    addToolApprovalResponse,
    addToolOutput,
    status,
    error,
  } = useChat({
    id: chatId,
    messages: initialMessages,
    transport,
    resume: resumeProp,
    sendAutomaticallyWhen: (opts) =>
      lastAssistantMessageIsCompleteWithApprovalResponses(opts) ||
      lastAssistantMessageIsCompleteWithToolCalls(opts),
  });

  // Use transport.stopGeneration for reliable stop after reconnect.
  // Once the AI SDK passes abortSignal through reconnectToStream,
  // aiStop() alone will suffice. Until then, this covers both cases.
  const stop = useCallback(() => {
    transport.stopGeneration(chatId);
    aiStop();
  }, [transport, chatId, aiStop]);

  // Tool approval callbacks
  const handleApprove = useCallback(
    (approvalId: string) => {
      addToolApprovalResponse({ id: approvalId, approved: true });
    },
    [addToolApprovalResponse, chatId, messages, status]
  );

  const handleDeny = useCallback(
    (approvalId: string) => {
      addToolApprovalResponse({ id: approvalId, approved: false, reason: "User denied" });
    },
    [addToolApprovalResponse, chatId]
  );

  // Notify parent of first user message (for chat metadata creation)
  useEffect(() => {
    if (hasCalledFirstMessage.current) return;
    const firstUser = messages.find((m) => m.role === "user");
    if (firstUser) {
      hasCalledFirstMessage.current = true;
      const text = firstUser.parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join(" ");
      onFirstMessage?.(chatId, text);
    }
  }, [messages, chatId, onFirstMessage]);

  // TTFB detection: record when first assistant content appears after send
  useEffect(() => {
    if (status !== "streaming") return;
    if (sendTimestamp.current === null) return;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === "assistant") {
      const ttfbMs = Date.now() - sendTimestamp.current;
      const turn = turnCounter.current;
      sendTimestamp.current = null;
      setTtfbHistory((prev) => [...prev, { turn, ttfbMs }]);
    }
  }, [status, messages]);

  // Pending messages — handles steering messages during streaming
  const pending = usePendingMessages<ChatUiMessage>({
    transport,
    chatId,
    status,
    messages,
    setMessages,
    sendMessage,
    metadata: { model },
  });

  // Expose test helpers for automated testing via Chrome DevTools.
  // All actions go through refs so closures always call the latest version.
  const stateRef = useRef({ status, messages, pending: pending.pending });
  stateRef.current = { status, messages, pending: pending.pending };

  const actionsRef = useRef({
    steer: pending.steer,
    queue: pending.queue,
    promote: pending.promoteToSteering,
    send: (text: string) => {
      turnCounter.current++;
      sendTimestamp.current = Date.now();
      sendMessage({ text }, { metadata: { model } });
    },
    stop,
  });
  actionsRef.current = {
    steer: pending.steer,
    queue: pending.queue,
    promote: pending.promoteToSteering,
    send: (text: string) => {
      turnCounter.current++;
      sendTimestamp.current = Date.now();
      sendMessage({ text }, { metadata: { model } });
    },
    stop,
  };

  useEffect(() => {
    (window as any).__chat = {
      get status() {
        return stateRef.current.status;
      },
      get messages() {
        return stateRef.current.messages;
      },
      get pending() {
        return stateRef.current.pending;
      },
      get runId() {
        return transport.getSession(chatId)?.runId ?? session?.runId ?? null;
      },
      chatId,
      steer: (text: string) => actionsRef.current.steer(text),
      queue: (text: string) => actionsRef.current.queue(text),
      promote: (id: string) => actionsRef.current.promote(id),
      send: (text: string) => actionsRef.current.send(text),
      stop: () => actionsRef.current.stop(),
      // Wait for a tool call to appear, then steer
      steerOnToolCall: (text: string) =>
        new Promise<void>((resolve) => {
          const check = setInterval(() => {
            const { messages: msgs } = stateRef.current;
            const lastMsg = msgs[msgs.length - 1];
            const hasTool =
              lastMsg?.role === "assistant" &&
              lastMsg.parts?.some(
                (p: any) => p.type?.startsWith("tool-")
              );
            if (hasTool) {
              clearInterval(check);
              console.log(
                "[__chat] steerOnToolCall: tool detected, steering now. status:",
                stateRef.current.status
              );
              actionsRef.current.steer(text);
              resolve();
            }
          }, 200);
        }),
      // Wait for status to become a value
      waitForStatus: (target: string) =>
        new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (stateRef.current.status === target) {
              clearInterval(check);
              resolve();
            }
          }, 100);
        }),
      steerAfterDelay: (text: string, ms: number) =>
        new Promise<void>((r) =>
          setTimeout(() => {
            actionsRef.current.steer(text);
            r();
          }, ms)
        ),
      queueAfterDelay: (text: string, ms: number) =>
        new Promise<void>((r) =>
          setTimeout(() => {
            actionsRef.current.queue(text);
            r();
          }, ms)
        ),
    };
    return () => {
      delete (window as any).__chat;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  // Persist messages when a turn completes
  const prevStatus = useRef(status);
  useEffect(() => {
    const turnCompleted = prevStatus.current === "streaming" && status === "ready";
    prevStatus.current = status;
    if (!turnCompleted) return;
    if (messages.length > 0) {
      onMessagesChange?.(chatId, messages);
    }
  }, [status, messages, chatId, onMessagesChange]);

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Model selector for new chats */}
      {isNewChat && messages.length === 0 && onModelChange && (
        <div className="shrink-0 border-b border-gray-200 bg-gray-50 px-4 py-2 flex items-center gap-2">
          <span className="text-xs text-gray-500">Model:</span>
          <select
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Model badge for existing chats */}
      {(!isNewChat || messages.length > 0) && (
        <div className="shrink-0 border-b border-gray-200 bg-gray-50 px-4 py-2">
          <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
            {model}
          </span>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="pt-20 text-center text-sm text-gray-400">
            Send a message to start chatting.
          </p>
        )}

        {messages.map((message, messageIndex) => (
          <div
            key={message.id}
            className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div className={`max-w-[80%] ${message.role === "user" ? "" : "w-full"}`}>
              <div
                className={`rounded-lg px-4 py-2 text-sm ${
                  message.role === "user" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-900"
                }`}
              >
                {message.parts.map((part, i) => {
                  if (part.type === "text") {
                    if (message.role === "assistant") {
                      return (
                        <Streamdown
                          key={i}
                          animated
                          isAnimating={
                            status === "streaming" && messageIndex === messages.length - 1
                          }
                        >
                          {part.text}
                        </Streamdown>
                      );
                    }
                    return <span key={i}>{part.text}</span>;
                  }

                  if (part.type === "reasoning") {
                    return (
                      <details key={i} className="my-1">
                        <summary className="cursor-pointer text-xs text-gray-400">
                          Thinking...
                        </summary>
                        <div className="mt-1 rounded bg-gray-50 p-2 text-xs text-gray-500 whitespace-pre-wrap">
                          {part.text}
                        </div>
                      </details>
                    );
                  }

                  // Transient status parts — hide from rendered output
                  if (
                    part.type === "data-turn-status" ||
                    part.type === "data-background-context-injected"
                  ) {
                    return null;
                  }

                  if (part.type === "data-research-progress") {
                    return <ResearchProgress key={i} part={part} />;
                  }

                  if (part.type === "data-compaction") {
                    const data = (part as any).data as CompactionChunkData;
                    return (
                      <div
                        key={i}
                        className={`my-2 flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${
                          data.status === "compacting"
                            ? "border-blue-200 bg-blue-50 text-blue-700"
                            : "border-amber-200 bg-amber-50 text-amber-700"
                        }`}
                      >
                        <span>{data.status === "compacting" ? "⏳" : "✂️"}</span>
                        <span>
                          {data.status === "compacting"
                            ? `Compacting conversation${
                                data.totalTokens
                                  ? ` (${data.totalTokens.toLocaleString()} tokens)`
                                  : ""
                              }...`
                            : "Conversation compacted"}
                        </span>
                      </div>
                    );
                  }

                  if (part.type.startsWith("tool-")) {
                    return (
                      <ToolInvocation
                        key={i}
                        part={part}
                        onApprove={handleApprove}
                        onDeny={handleDeny}
                        onToolOutput={(toolCallId, output) =>
                          addToolOutput({ toolCallId, output })
                        }
                      />
                    );
                  }

                  if (pending.isInjectionPoint(part)) {
                    const injectedMsgs = pending.getInjectedMessages(part);
                    if (injectedMsgs.length === 0) return null;
                    return (
                      <div key={i} className="my-2 flex justify-end">
                        <div className="max-w-[60%]">
                          {injectedMsgs.map((m) => (
                            <div
                              key={m.id}
                              className="rounded-lg bg-purple-100 px-3 py-1.5 text-sm text-purple-800"
                            >
                              {m.text}
                            </div>
                          ))}
                          <div className="mt-0.5 text-right text-[10px] text-purple-400">
                            injected mid-response
                          </div>
                        </div>
                      </div>
                    );
                  }

                  if (part.type.startsWith("data-")) {
                    return (
                      <div
                        key={i}
                        className="my-1 rounded border border-gray-200 bg-gray-50 p-2 text-xs text-gray-500"
                      >
                        <span className="font-medium">{part.type}</span>
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">
                          {JSON.stringify((part as any).data, null, 2)}
                        </pre>
                      </div>
                    );
                  }

                  return null;
                })}
              </div>
            </div>
          </div>
        ))}

        {status === "streaming" && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="flex justify-start">
            <div className="rounded-lg bg-gray-100 px-4 py-2 text-sm text-gray-400">
              Thinking...
            </div>
          </div>
        )}

        {pending.pending.map((msg) => (
          <div key={msg.id} className="flex justify-end">
            <div className="max-w-[80%]">
              <div
                className={`rounded-lg px-4 py-2 text-sm text-white opacity-75 ${
                  msg.mode === "steering" ? "bg-purple-600" : "bg-gray-500"
                }`}
              >
                {msg.text}
              </div>
              <div className="mt-1 flex items-center justify-end gap-2">
                <span className="text-[10px] text-gray-400">
                  {msg.mode === "steering"
                    ? "Steering — waiting for injection point"
                    : "Queued for next turn"}
                </span>
                {msg.mode === "queued" && status === "streaming" && (
                  <button
                    type="button"
                    onClick={() => pending.promoteToSteering(msg.id)}
                    className="text-[10px] text-purple-500 hover:text-purple-700 underline"
                  >
                    Steer instead
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="shrink-0 border-t border-red-100 bg-red-50 px-4 py-2 text-sm text-red-600">
          {error.message}
        </div>
      )}

      {/* Debug panel */}
      <DebugPanel
        chatId={chatId}
        model={model}
        status={status}
        session={session}
        dashboardUrl={dashboardUrl}
        messageCount={messages.length}
        ttfbHistory={ttfbHistory}
      />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim()) return;
          if (status !== "streaming") {
            turnCounter.current++;
            sendTimestamp.current = Date.now();
          }
          pending.steer(input);
          setInput("");
        }}
        className="shrink-0 border-t border-gray-200 bg-white p-4"
      >
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message..."
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Send
          </button>
          {status === "streaming" && (
            <button
              type="button"
              disabled={!input.trim()}
              onClick={() => {
                if (!input.trim()) return;
                pending.queue(input);
                setInput("");
              }}
              className="rounded-lg bg-gray-500 px-4 py-2 text-sm font-medium text-white hover:bg-gray-600 disabled:opacity-50"
            >
              Queue
            </button>
          )}
          {status === "streaming" && (
            <button
              type="button"
              onClick={stop}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
            >
              Stop
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
