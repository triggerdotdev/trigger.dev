import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "@ai-sdk/react";
import type { dashboardAgent } from "@internal/dashboard-agent";
import type { AgentIntent, SuggestedPrompt, WatchSpec } from "@internal/dashboard-agent-contracts";
import { useNavigate } from "@remix-run/react";
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "~/components/primitives/Toast";
import { AgentQuotaNotice, AgentUpgradeBlock } from "./AgentUpgradeGate";
import { DashboardAgentComposer } from "./DashboardAgentComposer";
import { DashboardAgentContextBanner } from "./DashboardAgentContextBanner";
import { DashboardAgentHero } from "./DashboardAgentHero";
import { DashboardAgentMessages, type TurnActivity } from "./DashboardAgentMessages";
import { createTranscriptOrder, orderTranscript } from "./message-order";
import { appendRunFilters } from "./navigate-target";
import { pendingNavigateIntents, pendingWatchIntents } from "./pending-intents";
import type { AgentPageContext } from "./page-context-types";
import { useAgentMessageQuota } from "./useAgentMessageQuota";
import { useTriggerUriResolver } from "./useTriggerUriResolver";
import { WatchChips, type WatchChip } from "./WatchChips";

// The persisted session for a chat: the session-scoped token plus the stream
// cursor. Resuming with `lastEventId` stops the `.out` stream from replaying the
// previous turn.
export type DashboardAgentSession = {
  publicAccessToken: string;
  lastEventId?: string;
};

// Per-turn context for the agent. Matches the agent's clientDataSchema input.
export type DashboardAgentClientData = {
  userId: string;
  organizationId: string;
  projectId?: string;
  environmentId?: string;
  currentPage?: string;
  // What page the user is on, as facts rather than a path. Sent on create and on
  // every turn, so the agent sees where the user is now.
  pageContext?: AgentPageContext;
};

/**
 * A single conversation. The panel mounts this with `key={chatId}`, so each chat
 * gets its own transport built with its persisted session: the resume cursor flows
 * in via the `sessions` option rather than an imperative setSession afterwards. A
 * fresh chat passes no session and starts a new run on first send.
 */
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
  watches,
  pagePaths,
  watchCard,
  appendedMessage,
  onWatchIntent,
  onCancelWatch,
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
  // Human label for the context banner. The path the agent sees travels
  // separately, in `clientData.currentPage`.
  currentPage: string;
  // Cold start: send this first message through the transport once on mount to
  // trigger the turn. Undefined for head-started and resumed chats.
  pendingFirstMessage?: string;
  // Head start: the turn is already in flight, so hydrate the session as
  // streaming so the transport resumes `session.out` instead of treating it as
  // a settled session with nothing to reconnect to.
  streaming?: boolean;
  // Text dropped into the composer from outside (the launcher's `openWith`).
  // `seq` makes each request distinct so the same text can be sent twice.
  prefill?: { text: string; seq: number };
  // The promoted chip from the feature flag. Only used for the suggested prompts
  // on an empty chat.
  promotedPrompt?: SuggestedPrompt;
  // This chat's active watches, from the panel's history load.
  watches: WatchChip[];
  /** Host-resolved dashboard paths for settings-page footer actions. */
  pagePaths?: Record<string, string>;
  /** The ephemeral watch card, when one is open. Sits above the composer. */
  watchCard?: React.ReactNode;
  /**
   * A message the server appended outside a turn (the watch card's confirmation or
   * one-shot result). Already durable in the store; this puts it in the live
   * transcript now. `seq` makes each append distinct so it applies exactly once.
   */
  appendedMessage?: { message: UIMessage; seq: number };
  /**
   * A card offered a watch. Every `watch` intent opens the configuration card
   * pre-filled with this spec, so nothing is posted or persisted unless the user
   * submits it.
   */
  onWatchIntent?: (spec: WatchSpec) => void;
  onCancelWatch: (watchId: string) => void;
  /** A watch was created — tell the panel to re-read the chips. */
  onTurnSettled: () => void;
  /**
   * Whether a turn is in flight, for the History list's row marker. Only this
   * component knows: the status is `useChat`'s, with nothing server-side to read
   * it back from.
   */
  onActivityChange?: (chatId: string, activity: TurnActivity | null) => void;
}) {
  const [input, setInput] = useState("");
  const navigate = useNavigate();
  const toast = useToast();

  // Put requested text in the composer rather than sending it, so the user can
  // read and edit before it goes.
  const prefilledSeq = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!prefill || prefilledSeq.current === prefill.seq) return;
    prefilledSeq.current = prefill.seq;
    setInput(prefill.text);
  }, [prefill]);

  const transport = useTriggerChatTransport<typeof dashboardAgent>({
    task: "dashboard-agent",
    baseURL: apiOrigin,
    // Only the `in`/append goes through the same-origin proxy, which injects the
    // delegated user token server-side and forwards the same path to the API.
    // `baseURL` stays a string so `out` (the long-lived SSE) keeps the SDK's
    // realtime-host routing.
    fetch: (url, init, ctx) => {
      if (ctx.endpoint !== "in") return globalThis.fetch(url, init);
      const { pathname, search } = new URL(url);
      return globalThis.fetch(`${actionPath}/in${pathname}${search}`, init);
    },
    clientData,
    sessions: session
      ? {
          [chatId]: {
            publicAccessToken: session.publicAccessToken,
            lastEventId: session.lastEventId,
            // Head-started chats are mid-turn, so mark the session streaming to
            // make the transport resume `session.out`. A settled session stays
            // false and loads its transcript from the store.
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
    // Resume an existing/head-started session's stream. A cold-start chat has a
    // session but nothing to resume yet — it sends its first message instead.
    resume: !!session && !pendingFirstMessage,
  });

  // The transcript in stable order: the store's copy is the base, live arrivals go
  // after it, and a replayed turn goes back into its own slot, so a message sent
  // right after a remount can't land between older turns. See `message-order.ts`.
  const orderRef = useRef(createTranscriptOrder(initialMessages));
  const messages = orderTranscript(rawMessages, orderRef.current);

  // The Free plan's message cap. Read here rather than in the panel so it counts
  // this chat's live transcript, including the turn just sent.
  const quota = useAgentMessageQuota({ actionPath, chatId, messages });
  const atMessageCap = quota.kind === "reached";

  const isStreaming = status === "streaming";
  // Derived from status rather than from the last part, so the indicator stays up
  // through long tool calls where the agent is busy but silent.
  const activity: TurnActivity | null =
    status === "submitted" ? "thinking" : status === "streaming" ? "working" : null;

  // Applied once per `seq`: the append is already persisted, so replaying it would
  // show the same confirmation twice.
  const appendedSeq = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!appendedMessage || appendedSeq.current === appendedMessage.seq) return;
    appendedSeq.current = appendedMessage.seq;
    setMessages((current) =>
      current.some((message) => message.id === appendedMessage.message.id)
        ? current
        : [...current, appendedMessage.message]
    );
  }, [appendedMessage, setMessages]);

  // Cold start: trigger the first turn by sending the pending message once.
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
      // The composer is gone at the cap, but a suggested prompt or a card action
      // can still call this, so the cap is enforced here too.
      if (!trimmed || isStreaming || atMessageCap) return;
      setInput("");
      void sendMessage({ text: trimmed });
    },
    [isStreaming, atMessageCap, sendMessage]
  );

  // Re-send the last thing the user asked. The failed turn produced nothing, so
  // there is no server-side state to unwind.
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

  // Sync facade over the route's `resolve` action: card links render as raw URIs
  // on first paint and become links once the server answers.
  const resolveUri = useTriggerUriResolver(actionPath);

  // A `navigate` target is a `trigger://` URI, so the path comes from the server,
  // which owns the environment scope. Same-origin, so the panel survives the
  // client-side navigation.
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

  // What a card's action does. An `ask` goes back into the conversation as the
  // user's own question. A `watch` does not: it opens the configuration card
  // pre-filled, so the user reviews it first and an abandoned offer leaves no
  // trace. `propose_fix` is reserved and must never be executed.
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

  // The `navigate_to` tool answers with an intent the agent then narrates in the
  // past tense, so the panel has to actually move. Seeded with the loaded
  // transcript before the first render, so history never navigates on replay:
  // only calls that land while this chat is open are honoured, once each.
  const navigatedRef = useRef<Set<string> | null>(null);
  if (navigatedRef.current === null) {
    navigatedRef.current = new Set();
    pendingNavigateIntents(initialMessages, navigatedRef.current);
  }
  useEffect(() => {
    const pending = pendingNavigateIntents(messages, navigatedRef.current!);
    // Only the last one matters — the earlier destinations are already history.
    const target = pending.at(-1);
    if (target) void goTo(target);
  }, [messages, goTo]);

  // `schedule_watch` proposes rather than creates: the panel opens the card
  // pre-filled so a free-text ask is reviewed like any other watch. Seeded and
  // deduped like navigate, so reopening a chat never reopens the card.
  const watchProposedRef = useRef<Set<string> | null>(null);
  if (watchProposedRef.current === null) {
    watchProposedRef.current = new Set();
    pendingWatchIntents(initialMessages, watchProposedRef.current);
  }
  useEffect(() => {
    const pending = pendingWatchIntents(messages, watchProposedRef.current!);
    // One card at a time, so the newest proposal is the one to review.
    const proposed = pending.at(-1);
    if (proposed) onWatchIntent?.(proposed.spec);
  }, [messages, onWatchIntent]);

  const stop = useCallback(() => {
    transport.stopGeneration(chatId);
    aiStop();
  }, [transport, chatId, aiStop]);

  // Refresh the panel's history list once a turn settles, so a new chat appears
  // and titles stay current.
  const prevStatus = useRef(status);
  useEffect(() => {
    const wasInFlight = prevStatus.current === "streaming" || prevStatus.current === "submitted";
    const nowSettled = status === "ready" || status === "error";
    if (wasInFlight && nowSettled) onTurnSettled();
    prevStatus.current = status;
  }, [status, onTurnSettled]);

  // Not cleared on unmount: opening History unmounts this chat but the turn
  // carries on server-side, and it reports again when it remounts.
  useEffect(() => {
    onActivityChange?.(chatId, activity);
  }, [chatId, activity, onActivityChange]);

  return (
    <>
      {/* Watch outcomes arrive in the transcript unprompted, so the chips explain
          where those messages come from. A chip is an offer to cancel, so only
          live watches get one; the full list still flows to the messages. */}
      <WatchChips
        watches={watches.filter((watch) => watch.status === "active")}
        onCancel={onCancelWatch}
      />
      {/* A cold-start chat mounts with no messages and a first message about to be
          sent, so without the pending-send gate the prompts flash for a frame. */}
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
          watches={watches}
          resolveUri={resolveUri}
        />
      )}
      {/* Inset to line up with the docked composer below it. */}
      {watchCard ? <div className="px-3 pb-2">{watchCard}</div> : null}
      {/* At the message cap the composer is replaced by the upgrade block, since a
          composer you can't send from is worse than none. The transcript above
          stays readable either way. */}
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
