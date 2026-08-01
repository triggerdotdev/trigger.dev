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
import { DashboardAgentMessages, type TurnActivity } from "./DashboardAgentMessages";
import { DashboardAgentSuggestedPrompts } from "./DashboardAgentSuggestedPrompts";
import { createTranscriptOrder, orderTranscript } from "./message-order";
import { appendRunFilters, pendingNavigateIntents } from "./navigate-target";
import type { AgentPageContext } from "./page-context-types";
import { useAgentMessageQuota } from "./useAgentMessageQuota";
import { useTriggerUriResolver } from "./useTriggerUriResolver";

// The persisted session for a chat: the session-scoped token plus the stream
// cursor. Resuming with `lastEventId` is what stops the agent's `.out` stream
// from replaying the previous turn.
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
  // What page the user is on, as facts rather than a path. Sent on create and
  // on every turn, so the agent sees where the user is now — not where they
  // were when the chat started.
  pageContext?: AgentPageContext;
};

/**
 * A single conversation. The panel mounts this with `key={chatId}`, so each
 * chat gets its own transport constructed with its persisted session — the
 * resume cursor flows in declaratively via the `sessions` option rather than
 * an imperative setSession after the fact. A fresh chat passes no session and
 * starts a new run on first send.
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
  // Human label for the current page, for the context banner. The path the agent
  // sees travels separately, in `clientData.currentPage`.
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
  // The product-controlled promoted chip, from the feature flag. Only used for
  // the suggested prompts on an empty chat.
  promotedPrompt?: SuggestedPrompt;
  /** Host-resolved dashboard paths for settings-page footer actions. */
  pagePaths?: Record<string, string>;
  /** A turn settled — tell the panel to refresh its history list. */
  onTurnSettled: () => void;
  /**
   * Whether a turn is in flight, for the History list's row marker. Only this
   * component knows — the turn status is `useChat`'s, with nothing server-side
   * to read it back from.
   */
  onActivityChange?: (chatId: string, activity: TurnActivity | null) => void;
}) {
  const [input, setInput] = useState("");
  const navigate = useNavigate();
  const toast = useToast();

  // Put requested text in the composer rather than sending it: a chat is already
  // open, so the user gets to read and edit before it goes.
  const prefilledSeq = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!prefill || prefilledSeq.current === prefill.seq) return;
    prefilledSeq.current = prefill.seq;
    setInput(prefill.text);
  }, [prefill]);

  const transport = useTriggerChatTransport<typeof dashboardAgent>({
    task: "dashboard-agent",
    baseURL: apiOrigin,
    // New chats are created server-side (the `create` action owns the id and
    // runs head start), so there's no client-driven head-start route here.
    // Redirect only the `in`/append to the same-origin proxy, which mints +
    // injects the delegated user token server-side. `baseURL` stays a string so
    // `out` (the long-lived SSE) keeps the SDK's realtime-host routing — we
    // never override it. The proxy forwards the same path on to the API.
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
            // make the transport resume `session.out`. A settled session
            // (history) stays false — its transcript loads from the store.
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

  // The transcript in stable order. The store's copy is the base; live arrivals
  // go after it, and a turn the stream replays goes back into its own slot — so
  // a message sent right after a remount can't land between older turns. See
  // `message-order.ts`.
  const orderRef = useRef(createTranscriptOrder(initialMessages));
  const messages = orderTranscript(rawMessages, orderRef.current);

  // The Free plan's message cap. Read here rather than in the panel so it counts
  // this chat's live transcript — including the turn just sent. `unlimited` on
  // any paid plan, and on any plan we can't identify.
  const quota = useAgentMessageQuota({ actionPath, chatId, messages });
  const atMessageCap = quota.kind === "reached";

  const isStreaming = status === "streaming";
  // A turn is in flight from submit until it settles. Deriving the indicator
  // from status (rather than from what the last part happens to be) keeps it up
  // through long tool calls, where the agent is busy but silent.
  const activity: TurnActivity | null =
    status === "submitted" ? "thinking" : status === "streaming" ? "working" : null;

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
      // The composer is gone at the cap, but a suggested prompt or a card's
      // action can still call this — so the cap is enforced here, not just in
      // what's rendered.
      if (!trimmed || isStreaming || atMessageCap) return;
      setInput("");
      void sendMessage({ text: trimmed });
    },
    [isStreaming, atMessageCap, sendMessage]
  );

  // Re-send the last thing the user asked. The failed turn produced nothing, so
  // sending the same text again is the whole retry — no server-side state to
  // unwind.
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

  // Take the user where a `navigate` intent points. The target is a `trigger://`
  // URI, so the path comes from the server (the route's `resolve` intent, which
  // owns the environment scope the resolver needs); the intent's runs-list
  // filters are applied on top. Same-origin, so this is a client-side navigation
  // — the panel lives in the env layout and survives it.
  // Sync facade over the same `resolve` action — evidence and card links render
  // as raw URIs on first paint and become links once the server answers.
  const resolveUri = useTriggerUriResolver(actionPath);

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
  // user's own question, so the click is visible in the transcript rather than
  // happening silently.
  //
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

  // The `navigate_to` tool answers with an intent and the agent then narrates it
  // in the past tense ("you're now on…"), so the panel has to actually move.
  // Seeded with the loaded transcript before the first render, so opening a chat
  // whose history contains a navigation never navigates on replay — only calls
  // that land while this chat is open are honoured, once each.
  const navigatedRef = useRef<Set<string> | null>(null);
  if (navigatedRef.current === null) {
    navigatedRef.current = new Set();
    pendingNavigateIntents(initialMessages, navigatedRef.current);
  }
  useEffect(() => {
    const pending = pendingNavigateIntents(messages, navigatedRef.current!);
    // Only the last one matters — the earlier destinations are already history.
    const target = pending.at(-1);
    if (target?.kind === "navigate") void goTo(target);
  }, [messages, goTo]);

  const stop = useCallback(() => {
    transport.stopGeneration(chatId);
    aiStop();
  }, [transport, chatId, aiStop]);

  // Tell the panel to refresh its history list once a turn settles, so the new
  // chat appears and titles/timestamps stay current.
  const prevStatus = useRef(status);
  useEffect(() => {
    const wasInFlight = prevStatus.current === "streaming" || prevStatus.current === "submitted";
    const nowSettled = status === "ready" || status === "error";
    if (wasInFlight && nowSettled) onTurnSettled();
    prevStatus.current = status;
  }, [status, onTurnSettled]);

  // Report the turn's activity up, so the History list can mark this chat while
  // it's working. Not cleared on unmount: opening History unmounts this chat but
  // the turn carries on server-side, and it reports again when it remounts.
  useEffect(() => {
    onActivityChange?.(chatId, activity);
  }, [chatId, activity, onActivityChange]);

  return (
    <>
      {/* A cold-start chat mounts with no messages and a first message about to
          be sent, so the prompts would flash for a frame before the transcript
          replaced them. Gate on that pending send. */}
      {messages.length === 0 && !pendingFirstMessage ? (
        <DashboardAgentSuggestedPrompts
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
      {/* The Free plan's message cap occupies the composer slot: at the cap the
          composer is replaced by the upgrade block (a composer you can't send
          from is worse than none), and under it the composer is followed by the
          remaining count. The transcript above is untouched either way — the
          conversation you already had stays readable. */}
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
