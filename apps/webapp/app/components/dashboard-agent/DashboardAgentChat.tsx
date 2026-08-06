import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "@ai-sdk/react";
import type { dashboardAgent } from "@internal/dashboard-agent";
import type { AgentIntent, SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { useNavigate } from "@remix-run/react";
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "~/components/primitives/Toast";
import { AgentQuotaNotice, AgentUpgradeBlock } from "./AgentUpgradeGate";
import { DashboardAgentComposer } from "./DashboardAgentComposer";
import { DashboardAgentContextBanner } from "./DashboardAgentContextBanner";
import { DashboardAgentHero } from "./DashboardAgentHero";
import { DashboardAgentMessages, type TurnActivity } from "./DashboardAgentMessages";
import { MESSAGE_TOO_LARGE_ERROR } from "./message-limits";
import { createTranscriptOrder, orderTranscript } from "./message-order";
import { appendRunFilters } from "./navigate-target";
import { pendingNavigateIntents } from "./pending-intents";
import type { AgentPageContext } from "./page-context-types";
import {
  fetchChatTranscript,
  hasOpenInvestigation,
  pollSettledTranscript,
} from "./settled-transcript";
import { useAgentMessageQuota } from "./useAgentMessageQuota";
import { useTriggerUriResolver } from "./useTriggerUriResolver";

// Resuming with `lastEventId` stops the `.out` stream replaying the previous turn.
export type DashboardAgentSession = {
  publicAccessToken: string;
  lastEventId?: string;
};

// Matches the agent's clientDataSchema input.
export type DashboardAgentClientData = {
  userId: string;
  organizationId: string;
  projectId?: string;
  environmentId?: string;
  currentPage?: string;
  pageContext?: AgentPageContext;
};

/** Mounted with `key={chatId}`: the resume cursor arrives via `sessions`, not setSession. */
export function DashboardAgentChat({
  chatId,
  initialMessages,
  session,
  clientData,
  apiOrigin,
  actionPath,
  projectSlug,
  environmentSlug,
  currentPage,
  pendingFirstMessage,
  streaming,
  prefill,
  promotedPrompt,
  pagePaths,
  onTurnSettled,
  onActivityChange,
}: {
  chatId: string;
  initialMessages: UIMessage[];
  session: DashboardAgentSession | null;
  clientData: DashboardAgentClientData;
  apiOrigin: string;
  actionPath: string;
  projectSlug: string;
  environmentSlug: string;
  // Display label only; the path the agent sees is `clientData.currentPage`.
  currentPage: string;
  // Undefined for head-started and resumed chats.
  pendingFirstMessage?: string;
  streaming?: boolean;
  // `seq` makes each request distinct so the same text can be sent twice.
  prefill?: { text: string; seq: number };
  promotedPrompt?: SuggestedPrompt;
  pagePaths?: Record<string, string>;
  onTurnSettled: () => void;
  onActivityChange?: (chatId: string, activity: TurnActivity | null) => void;
}) {
  const [input, setInput] = useState("");
  const navigate = useNavigate();
  const toast = useToast();

  const prefilledSeq = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!prefill || prefilledSeq.current === prefill.seq) return;
    prefilledSeq.current = prefill.seq;
    setInput(prefill.text);
  }, [prefill]);

  const transport = useTriggerChatTransport<typeof dashboardAgent>({
    task: "dashboard-agent",
    baseURL: apiOrigin,
    // Only `in` goes through the same-origin proxy, which injects the delegated user
    // token server-side. `baseURL` stays a string so `out` keeps the SDK's realtime routing.
    fetch: async (url, init, ctx) => {
      if (ctx.endpoint !== "in") return globalThis.fetch(url, init);
      const { pathname, search } = new URL(url);
      const res = await globalThis.fetch(`${actionPath}/in${pathname}${search}`, init);
      // A refused message never succeeds on a retry, so it surfaces as the turn's error.
      if (res.status === 413) {
        const data = (await res
          .clone()
          .json()
          .catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? MESSAGE_TOO_LARGE_ERROR);
      }
      return res;
    },
    clientData,
    sessions: session
      ? {
          [chatId]: {
            publicAccessToken: session.publicAccessToken,
            lastEventId: session.lastEventId,
            // Mid-turn chats must be marked streaming or the transport won't resume `session.out`.
            isStreaming: streaming ?? false,
          },
        }
      : undefined,
    startSession: async ({ chatId }) => {
      const body = new FormData();
      body.set("intent", "start");
      body.set("chatId", chatId);
      body.set("clientData", JSON.stringify(clientData));
      const res = await fetch(actionPath, { method: "POST", body });
      const data = (await res.json()) as { publicAccessToken?: string; error?: string };
      if (!res.ok || !data.publicAccessToken) {
        throw new Error(data.error ?? "The chat couldn't start.");
      }
      return { publicAccessToken: data.publicAccessToken };
    },
    accessToken: async ({ chatId }) => {
      const body = new FormData();
      body.set("intent", "token");
      body.set("chatId", chatId);
      const res = await fetch(actionPath, { method: "POST", body });
      const data = (await res.json()) as { token?: string; error?: string };
      if (!res.ok || !data.token) {
        throw new Error(data.error ?? "Couldn't refresh the chat token.");
      }
      return data.token;
    },
  });

  const {
    messages: rawMessages,
    setMessages,
    sendMessage,
    status,
    stop: aiStop,
    error,
    clearError,
  } = useChat({
    id: chatId,
    messages: initialMessages,
    transport,
    resume: !!session && !pendingFirstMessage,
  });

  const orderRef = useRef(createTranscriptOrder(initialMessages));
  const messages = orderTranscript(rawMessages, orderRef.current);

  // Counted here, not in the panel, so it includes the turn just sent.
  const quota = useAgentMessageQuota({ actionPath, chatId, messages });
  const atMessageCap = quota.kind === "reached";

  const isStreaming = status === "streaming";
  // From status, not the last part: the indicator must stay up through silent tool calls.
  const activity: TurnActivity | null =
    status === "submitted" ? "thinking" : status === "streaming" ? "working" : null;

  const sentFirst = useRef(false);
  useEffect(() => {
    if (pendingFirstMessage && !sentFirst.current) {
      sentFirst.current = true;
      void sendMessage({ text: pendingFirstMessage });
    }
  }, [pendingFirstMessage, sendMessage]);

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      // Suggested prompts and card actions bypass the composer, so the cap is enforced here too.
      if (!trimmed || isStreaming || atMessageCap) return;
      setInput("");
      void sendMessage({ text: trimmed });
    },
    [isStreaming, atMessageCap, sendMessage]
  );

  const retry = useCallback(() => {
    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    const text = lastUserMessage?.parts
      ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim();
    clearError();
    if (text) void sendMessage({ text });
  }, [messages, sendMessage, clearError]);

  const resolveUri = useTriggerUriResolver(actionPath);

  // `trigger://` targets resolve server-side: the server owns the environment scope.
  const goTo = useCallback(
    async (intent: Extract<AgentIntent, { kind: "navigate" }>) => {
      const body = new FormData();
      body.set("intent", "resolve");
      body.set("uri", intent.target);
      try {
        const res = await fetch(actionPath, { method: "POST", body });
        const data = (await res.json()) as { path?: string };
        if (!res.ok || !data.path) throw new Error(`Resolve failed (${res.status})`);
        navigate(appendRunFilters(data.path, intent.filters));
      } catch (error) {
        console.error("Dashboard agent: failed to resolve a navigate target", error);
        toast.error("Couldn't open that page.");
      }
    },
    [actionPath, navigate, toast]
  );

  // `propose_fix` is reserved and must never be executed.
  const handleIntent = useCallback(
    (intent: AgentIntent) => {
      switch (intent.kind) {
        case "ask":
          submit(intent.prompt);
          return;
        case "navigate":
          void goTo(intent);
          return;
        default:
          console.warn(`Dashboard agent: unhandled intent "${intent.kind}"`);
      }
    },
    [submit, goTo]
  );

  // Seeded from the loaded transcript before first render, so history never re-navigates.
  const navigatedRef = useRef<Set<string> | null>(null);
  if (navigatedRef.current === null) {
    navigatedRef.current = new Set();
    pendingNavigateIntents(initialMessages, navigatedRef.current);
  }
  useEffect(() => {
    const pending = pendingNavigateIntents(messages, navigatedRef.current!);
    const target = pending.at(-1);
    if (target) void goTo(target);
  }, [messages, goTo]);

  const stop = useCallback(() => {
    transport.stopGeneration(chatId);
    aiStop();
  }, [transport, chatId, aiStop]);

  // Read by the settle effect, which must not re-run when the transcript changes.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const prevStatus = useRef(status);
  useEffect(() => {
    const wasInFlight = prevStatus.current === "streaming" || prevStatus.current === "submitted";
    const nowSettled = status === "ready" || status === "error";
    prevStatus.current = status;
    if (!wasInFlight || !nowSettled) return;

    onTurnSettled();
    // The terminal card is written to the chat row after the stream closes, so this
    // mounted panel would otherwise keep showing the last `in_progress` revision.
    if (!hasOpenInvestigation(messagesRef.current)) return;
    void pollSettledTranscript<UIMessage>({
      fetchTranscript: () => fetchChatTranscript(actionPath, chatId),
      apply: (merge) => setMessages((current) => merge(current)),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  }, [status, onTurnSettled, actionPath, chatId, setMessages]);

  // Not cleared on unmount: the turn carries on server-side and reports again on remount.
  useEffect(() => {
    onActivityChange?.(chatId, activity);
  }, [chatId, activity, onActivityChange]);

  return (
    <>
      {messages.length === 0 && !pendingFirstMessage ? (
        <DashboardAgentHero
          onSelect={submit}
          pageContext={clientData.pageContext}
          promoted={promotedPrompt}
        />
      ) : (
        <DashboardAgentMessages
          messages={messages}
          activity={activity}
          error={error}
          onRetry={retry}
          onDismissError={clearError}
          onIntent={handleIntent}
          pagePaths={pagePaths}
          resolveUri={resolveUri}
        />
      )}
      {quota.kind === "reached" ? (
        <AgentUpgradeBlock
          limit={quota.limit}
          context={
            <DashboardAgentContextBanner
              projectSlug={projectSlug}
              environmentSlug={environmentSlug}
              currentPage={currentPage}
            />
          }
        />
      ) : (
        <>
          <DashboardAgentComposer
            value={input}
            onChange={setInput}
            onSubmit={() => submit(input)}
            onStop={stop}
            isStreaming={isStreaming}
            focusKey={prefill?.seq}
            context={
              <DashboardAgentContextBanner
                projectSlug={projectSlug}
                environmentSlug={environmentSlug}
                currentPage={currentPage}
              />
            }
          />
          {quota.kind === "within" && (
            <AgentQuotaNotice remaining={quota.remaining} limit={quota.limit} />
          )}
        </>
      )}
    </>
  );
}
