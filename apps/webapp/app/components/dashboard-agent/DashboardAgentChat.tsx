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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlusIcon } from "~/assets/icons/PlusIcon";
import { Button } from "~/components/primitives/Buttons";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { useToast } from "~/components/primitives/Toast";
import { AgentQuotaNotice, AgentUpgradeBlock } from "./AgentUpgradeGate";
import { DashboardAgentComposer } from "./DashboardAgentComposer";
import { DashboardAgentContextBanner } from "./DashboardAgentContextBanner";
import { DashboardAgentHero } from "./DashboardAgentHero";
import { NEW_CHAT_SHORTCUT } from "./DashboardAgentHeader";
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
import { earliestInFlightToolCall } from "./progress-line";
import { retryAction } from "./retry-action";
import {
  fetchChatTranscript,
  pollSettledTranscript,
  transcriptLooksUnfinished,
} from "./settled-transcript";
import { toolPendingLabel } from "./tool-labels";
import { takeNavigateIntent } from "./turn-navigation";
import { sendRequestOutcome } from "./send-request";
import {
  createKeyedDeadline,
  isTurnInFlight,
  NO_FIRST_EVENT_DEADLINE_MS,
  noFirstEventKey,
  TOOL_HUNG_DEADLINE_MS,
  type TurnDeadlineState,
} from "./turn-deadlines";
import { teardownCancelsTurn, unmountTeardown } from "./turn-teardown";
import { useAgentMessageQuota } from "./useAgentMessageQuota";
import { useRetryController } from "./use-retry-controller";
import { useTriggerUriResolver } from "./useTriggerUriResolver";
import { WatchChips, type WatchChip } from "./WatchChips";

// Resuming with `lastEventId` stops the `.out` stream replaying the previous turn.
export type DashboardAgentSession = {
  publicAccessToken: string;
  lastEventId?: string;
};

/** The transport's `sessions` option for one chat. Extracted so the resume wiring is testable. */
export function chatSessionsOption(
  chatId: string,
  session: DashboardAgentSession | null,
  streaming: boolean | undefined
) {
  if (!session) return undefined;
  return {
    [chatId]: {
      publicAccessToken: session.publicAccessToken,
      lastEventId: session.lastEventId,
      // Mid-turn chats must be marked streaming or the transport won't resume `session.out`.
      isStreaming: streaming ?? false,
    },
  };
}

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
  projectName,
  environmentSlug,
  entityId,
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
  onNewChat,
  showNewChat,
}: {
  chatId: string;
  initialMessages: UIMessage[];
  session: DashboardAgentSession | null;
  clientData: DashboardAgentClientData;
  apiOrigin: string;
  actionPath: string;
  projectName: string;
  environmentSlug: string;
  /** Shown in the context banner; the path the agent sees is `clientData.currentPage`. */
  entityId?: string;
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
  onNewChat: () => void;
  showNewChat: boolean;
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
    sessions: chatSessionsOption(chatId, session, streaming),
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

  // Independent of the SDK's own `error`: a deadline firing never touches the server
  // turn or `status`, it only bounds how long the panel waits before saying something.
  const [deadlineState, setDeadlineState] = useState<TurnDeadlineState | null>(null);
  const [hungTool, setHungTool] = useState<string | null>(null);
  // A resend re-enters `status: "submitted"`, the same value a stuck turn left it in —
  // `setStatus` is a no-op when unchanged, so nothing re-triggers the effect below without this.
  const [attempt, setAttempt] = useState(0);
  const noFirstEventDeadline = useRef(
    createKeyedDeadline<"submitted">({
      deadlineMs: NO_FIRST_EVENT_DEADLINE_MS,
      onTimeout: () => {
        // Nothing ever streamed, so the prior run may have died without writing a
        // `trigger:turn-complete` boundary — the one thing that normally clears the
        // supersede gate a stop arms. Left gated, the retry below would be silently
        // ignored server-side. Not done on the tool-hung path: there, a real turn did
        // start, so a stop (if the user retries) is what should arm/clear the gate.
        transport.clearSupersedeGate(chatId);
        setDeadlineState("no_first_event");
      },
      onClear: () => setDeadlineState((current) => (current === "no_first_event" ? null : current)),
    })
  ).current;
  // Keyed by call id, not name: a name key would restart the window whenever a
  // parallel sibling call settles or is replaced by a same-named call, masking a
  // genuinely hung one. Read by the timeout callback for the label, since by the time
  // it fires the tracked call is still the earliest pending one (same key, no reset).
  const hungToolNameRef = useRef<string | null>(null);
  const toolHungDeadline = useRef(
    createKeyedDeadline<string>({
      deadlineMs: TOOL_HUNG_DEADLINE_MS,
      onTimeout: () => {
        setDeadlineState("tool_hung");
        setHungTool(hungToolNameRef.current);
      },
      onClear: () => setDeadlineState((current) => (current === "tool_hung" ? null : current)),
    })
  ).current;
  useEffect(() => {
    noFirstEventDeadline.sync(noFirstEventKey(status));
  }, [status, noFirstEventDeadline, attempt]);
  useEffect(() => {
    // The earliest still-pending call is the one actually at risk of exceeding the deadline.
    const earliest = isTurnInFlight(status) ? earliestInFlightToolCall(messages) : undefined;
    hungToolNameRef.current = earliest?.name ?? null;
    toolHungDeadline.sync(earliest?.callId ?? null);
  }, [messages, status, toolHungDeadline]);

  const deadlineError = useMemo(() => {
    if (!deadlineState) return undefined;
    if (deadlineState === "no_first_event") {
      return new Error("The agent hasn't started responding. It may not be running — try again.");
    }
    return new Error(
      `${toolPendingLabel(hungTool ?? "")} is taking longer than expected. It may not be running — try again.`
    );
  }, [deadlineState, hungTool]);

  // Where this tab asked for the running turn, stamped only where a turn is actually started
  // here. A turn this tab resumed leaves it null, which is what tells `takeNavigateIntent` the
  // tab cannot claim the user is still on the page that asked. Never cleared on settle: the
  // navigate intent can be committed alongside the status going ready.
  const turnStartedPathRef = useRef<string | null>(null);

  const onRetrySettled = useCallback(
    (willResend: boolean) => {
      setDeadlineState(null);
      // Reset the deadlines' own key, not just the displayed state: a dangling tool part
      // that already fired once would otherwise never re-arm (same key, no change to sync).
      noFirstEventDeadline.reset();
      toolHungDeadline.reset();
      if (!willResend) return;
      setAttempt((current) => current + 1);
      turnStartedPathRef.current = renderedPathRef.current;
    },
    [noFirstEventDeadline, toolHungDeadline]
  );

  const {
    stop,
    retry: retryAgainstAction,
    dismissError,
    stopFailedError,
  } = useRetryController({
    chatId,
    transport,
    status,
    stop: aiStop,
    sendMessage,
    regenerate,
    clearError,
    onSettled: onRetrySettled,
  });

  // The SDK's own error wins when both are present — it's the more specific failure.
  const effectiveError = error ?? deadlineError ?? stopFailedError;

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

  // Named for the composer's stop-vs-send affordance, but gates on the whole in-flight
  // window (submitted or streaming): a deadline error can only ever show while the turn
  // is still in flight, and a fresh send during that window would race it instead of
  // going through `useRetryController`'s stop-first path.
  const isStreaming = isTurnInFlight(status);
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

  // Over the cap, a retry only earns another 403 — same guard as `submit`. A watch's
  // consent record is a user message nobody typed, so retry never treats it as one.
  const retry = useCallback(() => {
    if (atMessageCap) return;
    const action = retryAction(
      messages.filter((m) => !(m.role === "user" && isWatchRequestMessageId(m.id)))
    );
    retryAgainstAction(action);
  }, [messages, atMessageCap, retryAgainstAction]);

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

  const teardownRef = useRef<() => void>(() => {});

  teardownRef.current = () => {
    if (!isTurnInFlight(status)) return;
    const reason = unmountTeardown({
      renderedPath: renderedPathRef.current,
      livePath: window.location.pathname,
    });
    if (!teardownCancelsTurn(reason)) return;
    // Fire-and-forget: nothing is mounted to show a stop failure after unmount, and an
    // uncaught rejection here would otherwise surface as an unhandled rejection.
    void stop().catch(() => {});
  };
  useEffect(() => () => teardownRef.current(), []);
  useEffect(
    () => () => {
      noFirstEventDeadline.reset();
      toolHungDeadline.reset();
    },
    [noFirstEventDeadline, toolHungDeadline]
  );

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

  const isDraftState = messages.length === 0 && !pendingFirstMessage;

  const contextBanner = (
    <DashboardAgentContextBanner
      projectName={projectName}
      environmentSlug={environmentSlug}
      entityId={entityId}
    />
  );

  return (
    <>
      <WatchChips
        watches={watches.filter((watch) => watch.status === "active")}
        onCancel={onCancelWatch}
      />
      {isDraftState ? (
        <DashboardAgentHero
          onSelect={submit}
          pageContext={clientData.pageContext}
          promoted={promotedPrompt}
          promptsDisabledReason={atMessageCap ? MESSAGE_QUOTA_REACHED_REASON : undefined}
          composer={
            atMessageCap ? (
              <AgentUpgradeBlock
                limit={messageCapLimit}
                planResolved={messageCapPlanResolved}
                context={contextBanner}
              />
            ) : (
              <DashboardAgentComposer
                layout="hero"
                value={input}
                onChange={setInput}
                onSubmit={() => submit(input)}
                onStop={stop}
                isStreaming={isStreaming}
                focusKey={sendRequest?.seq}
                context={contextBanner}
              />
            )
          }
        />
      ) : (
        <DashboardAgentMessages
          messages={messages}
          activity={activity}
          error={effectiveError}
          onRetry={retry}
          retryDisabledReason={atMessageCap ? MESSAGE_QUOTA_REACHED_REASON : undefined}
          onDismissError={dismissError}
          onIntent={handleIntent}
          pagePaths={pagePaths}
          watches={watches}
          resolveUri={resolveUri}
        />
      )}
      {watchCard ? <div className="px-3 pb-2">{watchCard}</div> : null}
      {isDraftState ? null : atMessageCap ? (
        <AgentUpgradeBlock
          limit={messageCapLimit}
          planResolved={messageCapPlanResolved}
          context={contextBanner}
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
            context={contextBanner}
            trailingAction={
              showNewChat && (
                <Button
                  variant="minimal/small"
                  className="aspect-square h-6 shrink-0 p-1 mr-[6px]"
                  aria-label="New chat"
                  tooltip={
                    <span className="flex items-center">
                      New chat
                      <ShortcutKey shortcut={NEW_CHAT_SHORTCUT} variant="medium" />
                    </span>
                  }
                  onClick={onNewChat}
                  LeadingIcon={<PlusIcon className="size-4 text-text-dimmed" />}
                />
              )
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
