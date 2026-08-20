import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "@ai-sdk/react";
import type { dashboardAgent } from "@internal/dashboard-agent";
import {
  isWatchRequestMessageId,
  type AgentIntent,
  type SuggestedPrompt,
  type WatchSpec,
} from "@internal/dashboard-agent-contracts";
import { useLocation, useNavigate } from "@remix-run/react";
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "~/components/primitives/Toast";
import { AgentQuotaNotice, AgentUpgradeBlock } from "./AgentUpgradeGate";
import { DashboardAgentComposer } from "./DashboardAgentComposer";
import { DashboardAgentContextBanner } from "./DashboardAgentContextBanner";
import { DashboardAgentHero } from "./DashboardAgentHero";
import { DashboardAgentMessages, type TurnActivity } from "./DashboardAgentMessages";
import { MESSAGE_TOO_LARGE_ERROR } from "./message-limits";
import {
  FREE_PLAN_MESSAGE_LIMIT,
  MESSAGE_QUOTA_REACHED_REASON,
  parseQuotaReachedResponse,
  type MessageQuota,
} from "./message-quota";
import { createTranscriptOrder, orderTranscript } from "./message-order";
import { navigateDestination } from "./navigate-target";
import { pendingNavigateIntents, pendingWatchIntents } from "./pending-intents";
import type { AgentPageContext } from "./page-context-types";
import { retryAction } from "./retry-action";
import {
  fetchChatTranscript,
  pollSettledTranscript,
  transcriptLooksUnfinished,
} from "./settled-transcript";
import { takeNavigateIntent } from "./turn-navigation";
import { sendRequestOutcome } from "./send-request";
import { teardownCancelsTurn, unmountTeardown } from "./turn-teardown";
import { useAgentMessageQuota } from "./useAgentMessageQuota";
import { useTriggerUriResolver } from "./useTriggerUriResolver";
import { WatchChips, type WatchChip } from "./WatchChips";

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
  sendRequest,
  promotedPrompt,
  watches,
  pagePaths,
  watchCard,
  appendedMessages,
  onWatchIntent,
  onCancelWatch,
  onTurnSettled,
  onActivityChange,
  onQuotaChange,
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
  // A prompt the user asked for by clicking. `seq` makes each request distinct so the same
  // text can be sent twice.
  sendRequest?: { text: string; seq: number };
  promotedPrompt?: SuggestedPrompt;
  watches: WatchChip[];
  pagePaths?: Record<string, string>;
  watchCard?: React.ReactNode;
  appendedMessages?: { messages: UIMessage[]; seq: number };
  /** Nothing is persisted until the user submits the card. */
  onWatchIntent?: (spec: WatchSpec) => void;
  onCancelWatch: (watchId: string) => void;
  onTurnSettled: () => void;
  onActivityChange?: (chatId: string, activity: TurnActivity | null) => void;
  /** The poll lives here, so this is where the panel learns the cap has lifted. */
  onQuotaChange?: (quota: MessageQuota) => void;
}) {
  const [input, setInput] = useState("");
  // Set when the server refuses a send over the cap, so the block shows at once rather than
  // waiting for the next quota poll.
  const [quotaReached, setQuotaReached] = useState<{ limit: number; planResolved: boolean } | null>(
    null
  );
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  // The path this chat last rendered on. React never unmounts on a page teardown, so an
  // unmount whose live URL has moved is the router having navigated out from under it.
  const renderedPathRef = useRef(location.pathname);

  renderedPathRef.current = location.pathname;

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
      // Over the message cap: show the upgrade block instead of a generic turn error.
      if (res.status === 403) {
        const data = (await res
          .clone()
          .json()
          .catch(() => null)) as { error?: string; limit?: number } | null;
        const reached = parseQuotaReachedResponse(res.status, data);
        if (reached) {
          setQuotaReached(reached);
          throw new Error("You've reached your message limit.");
        }
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
    regenerate,
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

  // Read here, not in the panel, so it re-reads as each turn settles.
  const quota = useAgentMessageQuota({ actionPath, chatId, status });
  useEffect(() => {
    onQuotaChange?.(quota);
    // The quota object is rebuilt every render; only its kind is acted on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quota.kind, onQuotaChange]);
  // Either the poll saw the cap, or a send was just refused over it.
  const atMessageCap = quota.kind === "reached" || quotaReached !== null;
  const messageCapLimit =
    quotaReached?.limit ?? (quota.kind === "unlimited" ? FREE_PLAN_MESSAGE_LIMIT : quota.limit);
  // The poll only runs on the free plan, so its cap is the free-plan nudge; a refusal
  // carries the plan limit the server resolved.
  const messageCapPlanResolved = quotaReached?.planResolved ?? false;

  const isStreaming = status === "streaming";
  // From status, not the last part: the indicator must stay up through silent tool calls.
  const activity: TurnActivity | null =
    status === "submitted" ? "thinking" : status === "streaming" ? "working" : null;

  // Once per `seq`: the append is already persisted, so a replay would duplicate it.
  // Ids are stable, so anything already in the transcript is skipped.
  const appendedSeq = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!appendedMessages || appendedSeq.current === appendedMessages.seq) return;
    appendedSeq.current = appendedMessages.seq;
    setMessages((current) => {
      const missing = appendedMessages.messages.filter(
        (message) => !current.some((existing) => existing.id === message.id)
      );
      return missing.length === 0 ? current : [...current, ...missing];
    });
  }, [appendedMessages, setMessages]);

  // Where this tab asked for the running turn, stamped only where a turn is actually started
  // here. A turn this tab resumed leaves it null, which is what tells `takeNavigateIntent` the
  // tab cannot claim the user is still on the page that asked. Never cleared on settle: the
  // navigate intent can be committed alongside the status going ready.
  const turnStartedPathRef = useRef<string | null>(null);

  const sentFirst = useRef(false);
  useEffect(() => {
    if (pendingFirstMessage && !sentFirst.current) {
      sentFirst.current = true;
      turnStartedPathRef.current = renderedPathRef.current;
      void sendMessage({ text: pendingFirstMessage });
    }
  }, [pendingFirstMessage, sendMessage]);

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      // Suggested prompts and card actions bypass the composer, so the cap is enforced here too.
      if (!trimmed || isStreaming || atMessageCap) return;
      setInput("");
      turnStartedPathRef.current = renderedPathRef.current;
      void sendMessage({ text: trimmed });
    },
    [isStreaming, atMessageCap, sendMessage]
  );

  // The panel only sends when the chat can take it, so this never lands mid-turn. The cap it
  // cannot see is why the request is held rather than consumed on sight.
  const sentRequestSeq = useRef<number | undefined>(undefined);
  const canSend = !isStreaming && !atMessageCap;
  useEffect(() => {
    if (!sendRequest) return;
    const outcome = sendRequestOutcome({
      requestSeq: sendRequest.seq,
      consumedSeq: sentRequestSeq.current,
      canSend,
    });
    if (outcome !== "send") return;
    sentRequestSeq.current = sendRequest.seq;
    submit(sendRequest.text);
  }, [sendRequest, submit, canSend]);

  const retry = useCallback(() => {
    // Over the cap, a retry only earns another 403 — same guard as `submit`.
    if (atMessageCap) return;
    // A watch's consent record is a user message nobody typed, so retry never treats it as one.
    const action = retryAction(
      messages.filter((m) => !(m.role === "user" && isWatchRequestMessageId(m.id)))
    );
    if (!action) return;
    clearError();
    turnStartedPathRef.current = renderedPathRef.current;
    if (action.kind === "regenerate") {
      void regenerate();
      return;
    }
    void sendMessage({ text: action.text, messageId: action.messageId });
  }, [messages, sendMessage, regenerate, clearError, atMessageCap]);

  const resolveUri = useTriggerUriResolver(actionPath);

  // `trigger://` targets resolve server-side: the server owns the environment scope.
  const goTo = useCallback(
    async (intent: Extract<AgentIntent, { kind: "navigate" }>) => {
      const body = new FormData();
      body.set("intent", "resolve");
      body.set("uri", intent.target);
      try {
        const res = await fetch(actionPath, { method: "POST", body });
        const data = (await res.json()) as { path?: string; external?: boolean };
        if (!res.ok) throw new Error(`Resolve failed (${res.status})`);
        const destination = navigateDestination(data, intent.filters);
        if (destination.kind === "none") throw new Error("Resolved to nothing routable");
        if (destination.kind === "route") {
          navigate(destination.path);
          return;
        }
        // A source file lives on GitHub. The fetch above has already broken the gesture chain,
        // so a blocked popup falls back to leaving the dashboard rather than doing nothing.
        const opened = window.open(destination.url, "_blank", "noopener,noreferrer");
        if (!opened) window.location.assign(destination.url);
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
        case "watch":
          onWatchIntent?.(intent.spec);
          return;
        case "navigate":
          void goTo(intent);
          return;
        default:
          console.warn(`Dashboard agent: unhandled intent "${intent.kind}"`);
      }
    },
    [submit, goTo, onWatchIntent]
  );

  // Seeded from the loaded transcript before first render, so history never re-navigates.
  const navigatedRef = useRef<Set<string> | null>(null);
  if (navigatedRef.current === null) {
    navigatedRef.current = new Set();

    pendingNavigateIntents(initialMessages, navigatedRef.current);
  }
  useEffect(() => {
    const target = takeNavigateIntent({
      messages,
      handled: navigatedRef.current!,
      startedPath: turnStartedPathRef.current,
      currentPath: renderedPathRef.current,
    });
    if (target) void goTo(target);
  }, [messages, goTo]);

  const watchProposedRef = useRef<Set<string> | null>(null);
  if (watchProposedRef.current === null) {
    watchProposedRef.current = new Set();

    pendingWatchIntents(initialMessages, watchProposedRef.current);
  }
  useEffect(() => {
    const pending = pendingWatchIntents(messages, watchProposedRef.current!);
    const proposed = pending.at(-1);
    if (proposed) onWatchIntent?.(proposed.spec);
  }, [messages, onWatchIntent]);

  const stop = useCallback(() => {
    transport.stopGeneration(chatId);
    aiStop();
  }, [transport, chatId, aiStop]);

  const teardownRef = useRef<() => void>(() => {});

  teardownRef.current = () => {
    if (status !== "streaming" && status !== "submitted") return;
    const reason = unmountTeardown({
      renderedPath: renderedPathRef.current,
      livePath: window.location.pathname,
    });
    if (!teardownCancelsTurn(reason)) return;
    stop();
  };
  useEffect(() => () => teardownRef.current(), []);

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
    // mounted panel would otherwise keep showing the last `in_progress` revision — or,
    // if the stream died mid-tool, the tool call it never got an output for.
    if (!transcriptLooksUnfinished(messagesRef.current)) return;
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
      <WatchChips
        watches={watches.filter((watch) => watch.status === "active")}
        onCancel={onCancelWatch}
      />
      {messages.length === 0 && !pendingFirstMessage ? (
        <DashboardAgentHero
          onSelect={submit}
          pageContext={clientData.pageContext}
          promoted={promotedPrompt}
          promptsDisabledReason={atMessageCap ? MESSAGE_QUOTA_REACHED_REASON : undefined}
        />
      ) : (
        <DashboardAgentMessages
          messages={messages}
          activity={activity}
          error={error}
          onRetry={retry}
          retryDisabledReason={atMessageCap ? MESSAGE_QUOTA_REACHED_REASON : undefined}
          onDismissError={clearError}
          onIntent={handleIntent}
          pagePaths={pagePaths}
          watches={watches}
          resolveUri={resolveUri}
        />
      )}
      {watchCard ? <div className="px-3 pb-2">{watchCard}</div> : null}
      {atMessageCap ? (
        <AgentUpgradeBlock
          limit={messageCapLimit}
          planResolved={messageCapPlanResolved}
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
            focusKey={sendRequest?.seq}
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
