import { useChat } from "@ai-sdk/react";
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { dashboardAssistant } from "~/trigger/ai-assistant";
import { useAIChat } from "./AIChatProvider";
import { AIChatHeader } from "./AIChatHeader";
import { AIChatContextBanner } from "./AIChatContextBanner";
import { AIChatMessages } from "./AIChatMessages";
import { AIChatSuggestedPrompts } from "./AIChatSuggestedPrompts";
import { AIChatInput } from "./AIChatInput";

async function postAssistant(body: Record<string, unknown>): Promise<any> {
  const res = await fetch("/resources/ai-assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`ai-assistant ${body.intent} failed: ${res.status}`);
  }
  return res.json();
}

export function AIChatPanel() {
  const {
    currentChatId,
    currentChatMessages,
    pageContext,
    isOpen,
    close,
    pendingQuery,
    clearPendingQuery,
    refreshHistory,
    apiOperations,
  } = useAIChat();

  const panelRef = useRef<HTMLDivElement>(null);

  const [input, setInput] = useState("");

  const transport = useTriggerChatTransport<typeof dashboardAssistant>({
    task: "dashboard-assistant",
    // Head Start intentionally disabled: running every turn inside the agent
    // run is what surfaces the LLM + tool-call spans in the trace (at the cost
    // of ~750ms first-token).
    baseURL: typeof window !== "undefined" ? window.location.origin : undefined,
    clientData: pageContext,
    // Mint a fresh session-scoped PAT. Fired on first use + 401/403 refresh.
    accessToken: async ({ chatId }) => {
      const { publicAccessToken } = await postAssistant({
        intent: "refreshToken",
        chatId,
        clientData: pageContext,
      });
      return publicAccessToken;
    },
    // Create (or resume) the session + trigger the first run server-side.
    startSession: async ({ chatId }) => {
      const { publicAccessToken } = await postAssistant({
        intent: "createSession",
        chatId,
        clientData: pageContext,
      });
      return { publicAccessToken };
    },
  });

  const {
    messages,
    sendMessage,
    status,
    stop: aiStop,
    error,
    regenerate,
    addToolApprovalResponse,
  } = useChat({
    id: currentChatId,
    messages: currentChatMessages,
    transport,
    resume: (currentChatMessages?.length ?? 0) > 0,
    // When the user approves/denies a gated action, resume the agent so the
    // tool either runs or is reported as denied.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });

  const handleApprove = useCallback(
    (approvalId: string) => addToolApprovalResponse({ id: approvalId, approved: true }),
    [addToolApprovalResponse]
  );
  const handleDeny = useCallback(
    (approvalId: string) =>
      addToolApprovalResponse({ id: approvalId, approved: false, reason: "User denied" }),
    [addToolApprovalResponse]
  );

  const stop = useCallback(() => {
    transport.stopGeneration(currentChatId);
    aiStop();
  }, [transport, currentChatId, aiStop]);

  // Warm the agent run when the panel opens so it's waiting on `session.in`
  // by the time the user sends — a cold boot races the first message ahead of
  // the run's waitpoint and silently drops the turn.
  useEffect(() => {
    void transport.preload(currentChatId);
  }, [transport, currentChatId]);

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      void sendMessage({ text: trimmed });
      setInput("");
    },
    [sendMessage]
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      submit(input);
    },
    [submit, input]
  );

  // Close on Escape, but only when focus is inside the panel — a global
  // Escape listener would hijack the key from menus/inputs elsewhere.
  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && panelRef.current?.contains(document.activeElement)) {
        close();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, close]);

  // A pending query is set when the assistant is opened with an initial
  // question (e.g. from a "Ask AI about this" affordance). Send it once.
  const sentPending = useRef(false);
  useEffect(() => {
    if (pendingQuery && !sentPending.current) {
      sentPending.current = true;
      submit(pendingQuery);
      clearPendingQuery();
    }
    if (!pendingQuery) {
      sentPending.current = false;
    }
  }, [pendingQuery, submit, clearPendingQuery]);

  const prevStatus = useRef(status);
  useEffect(() => {
    if (prevStatus.current === "streaming" && status === "ready") {
      refreshHistory();
    }
    prevStatus.current = status;
  }, [status, refreshHistory]);

  const isLoading = status === "submitted" || status === "streaming";
  const isEmpty = messages.length === 0;

  return (
    <div
      ref={panelRef}
      className="flex h-full w-[380px] flex-col border-l border-grid-bright bg-background-bright animate-in fade-in slide-in-from-right-2 duration-200"
    >
      <AIChatHeader />
      <AIChatContextBanner
        projectSlug={pageContext.projectSlug}
        environmentSlug={pageContext.environmentSlug}
        currentPage={pageContext.currentPage}
      />

      {isEmpty ? (
        <div className="flex-1 overflow-y-auto py-3">
          <AIChatSuggestedPrompts currentPage={pageContext.currentPage} onSelect={submit} />
        </div>
      ) : (
        <AIChatMessages
          messages={messages}
          status={status}
          error={error}
          onRetry={() => void regenerate()}
          onApprove={handleApprove}
          onDeny={handleDeny}
          apiOperations={apiOperations}
        />
      )}

      <AIChatInput
        input={input}
        onInputChange={(e) => setInput(e.target.value)}
        onSubmit={handleSubmit}
        onStop={stop}
        isLoading={isLoading}
        status={status}
        chatId={currentChatId}
      />
    </div>
  );
}
