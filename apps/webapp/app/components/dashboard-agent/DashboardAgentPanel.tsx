import type { UIMessage } from "@ai-sdk/react";
import { useFetcher, useLocation, useNavigate, useRevalidator } from "@remix-run/react";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import { Spinner } from "~/components/primitives/Spinner";
import { useToast } from "~/components/primitives/Toast";
import { useAgentPageContext } from "~/hooks/useAgentPageContext";
import { useDashboardAgentBaseUrl } from "~/hooks/useDashboardAgentBaseUrl";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useFeatures } from "~/hooks/useFeatures";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import {
  DashboardAgentChat,
  type DashboardAgentClientData,
  type DashboardAgentSession,
} from "./DashboardAgentChat";
import { createCoalescedReload } from "./coalesced-reload";
import {
  forgetLastChat,
  lastChatStorageKey,
  readLastChat,
  shouldPersistLastChat,
  writeLastChat,
} from "./last-chat-storage";
import { DashboardAgentDraft } from "./DashboardAgentDraft";
import { DraftQuotaPoller } from "./DraftQuotaPoller";
import {
  parseQuotaReachedResponse,
  shouldClearCapReached,
  type MessageQuota,
} from "./message-quota";
import { WatchCard } from "./WatchCard";
import { watchDraftFor } from "./watch-card";
import { NO_WATCH_CARD, watchCardReducer } from "./watch-card-state";
import { forgetWatchActivity, rememberWatchActivity } from "./watch-activity";
import type { TurnActivity } from "./DashboardAgentMessages";
import { DashboardAgentHeader } from "./DashboardAgentHeader";
import type { DashboardAgentChat as DashboardAgentChatListItem } from "./DashboardAgentHistory";
import type { SuggestedPrompt, WatchSpec } from "@internal/dashboard-agent-contracts";
import { resolveOpenedChat, type OpenedChatResponse } from "./opened-chat";
import type { AgentPageContext } from "./page-context-types";
import { agentPageEntityId } from "./page-label";
import { explicitPromptTarget } from "./explicit-prompt";
import { escapeClosesPanel, ownsEscape } from "./panel-escape";
import {
  markChatListRead,
  nextVisibleChat,
  settleReadChats,
  unreadWorkCount,
} from "./unread-counts";
import { AgentPanelColumn, type DashboardAgentMode, type DragHandleProps } from "./panel-layout";
import { markerAfterActiveChat, markerAfterActivity } from "./thinking-marker";
import {
  concurrencyLimitsPath,
  v3AlertCreatePath,
  v3AlertPath,
  v3EnvironmentPath,
  v3ProjectAlertsPath,
  v3ProjectLegacyAlertsPath,
} from "~/utils/pathBuilder";
import { afterReplace, LEGACY_ALERTS_ROUTE_ID } from "~/components/alerts/legacyAlertChannels";
import { scopeMatchesPath, sessionPathFor } from "./agent-scope";
import type { AgentOpenSource } from "./manual-setup-action";
import { useCreationFlowState, type FlowAnswers } from "./alert-creation";
import { useCreationSession } from "./alert-creation/useCreationSession";
import { useCreationAgentSend } from "./alert-creation/useCreationAgentSend";
import {
  creationChatToReuse,
  chatTurnClientData,
  creationTurnClientData,
  rescopeTurnClientData,
  type CreationAgentChat,
  type ToolResultPayload,
} from "./alert-creation/draftPatch";
import type { AlertChannel, CreationResult } from "./alert-creation/CreationFlow";
import { CreationChatShell } from "~/components/alerts/CreationChatShell";
import { alertChannelsResourcePath } from "~/components/alerts/alertChannelsResourcePath";
import {
  EXPIRY_TOKEN_PATTERN,
  type AlertCreatedMessage,
} from "~/components/alerts/alertCreatedCard";
import { CreationTranscript } from "~/components/alerts/CreationTranscript";
import {
  EditAlertTranscript,
  type EditAlertPrefill,
} from "~/components/alerts/EditAlertTranscript";
import {
  alertName,
  asArea,
  resolveCapability,
  defaultWindowMinutes,
  searchParamsToAnswers,
  prefillToAnswers,
  isErrorGroupOnly,
  type DraftPrefillParams,
} from "./alert-creation/flow-state";
import { useErrorGroupSource } from "~/components/alerts/useErrorGroupLookup";
import {
  clearSlackConnectResume,
  readSlackConnectResume,
} from "~/components/alerts/slackConnectResume";
// "This chat" stays pickable before the chat exists; it is created when the alert is.
const CHAT_CREATED_ON_USE = "chat_on_use";

function createSearchKey(search: string): string {
  const p = new URLSearchParams(search);
  return [
    p.get("create"),
    p.get("area"),
    p.get("capability"),
    p.get("scope"),
    p.get("scopeValue"),
  ].join("|");
}

function draftFromSearch(search: string, hasChatId: boolean): FlowAnswers {
  const params = new URLSearchParams(search);
  const area = params.get("area") ?? undefined;
  const capability = params.get("capability") ?? undefined;
  const scope = params.get("scope") ?? undefined;
  const scopeValue = params.get("scopeValue") ?? undefined;
  const base =
    area || capability || scope
      ? searchParamsToAnswers({ area: asArea(area), capability, scope, scopeValue })
      : {};
  return { ...base, notifiers: hasChatId ? ["chat"] : [] };
}

function serializePageContext(pageContext: AgentPageContext): string | undefined {
  try {
    return JSON.stringify(pageContext);
  } catch {
    return undefined;
  }
}

type ActiveChat = {
  chatId: string;
  // The org the chat belongs to, so a switch can't file it under the new org's key.
  organizationId: string;
  messages: UIMessage[];
  session: DashboardAgentSession | null;
  pendingFirstMessage?: string;
  // Head start: the turn is already in flight, so the session hydrates as streaming.
  streaming?: boolean;
};

function expiryToIso(exp: string | undefined): string | undefined {
  if (!exp || exp === "none") return undefined;
  const EVENT_HOURS: Record<string, number> = { deploy: 168, incident: 720 };
  const hoursMatch = exp.match(/^(\d+)h$/);
  const hours = hoursMatch ? Number(hoursMatch[1]) : EVENT_HOURS[exp];
  if (hours) return new Date(Date.now() + hours * 3600_000).toISOString();
  return Number.isNaN(Date.parse(exp)) ? undefined : new Date(exp).toISOString();
}

// The server generates the chat id on the first send; the client never invents one.
export function DashboardAgentPanel({
  onClose,
  requestedMessage,
  createAlertPrefill,
  editAlertRequest,
  openChatRequest,
  newChatSeq,
  promotedPrompt,
  watchRequest,
  onChatRead,
  onUnreadWorkChange,
  onTurnActivityChange,
  mode = "floating",
  onModeChange,
  dragHandleProps,
  dragHandleClassName,
  watchEnabled = false,
  openSource,
}: {
  onClose: () => void;
  mode?: DashboardAgentMode;
  onModeChange?: (mode: DashboardAgentMode) => void;
  /** Spread onto the header, which is the floating window's drag handle; already filtered by `FloatingAgentWindow`. */
  dragHandleProps?: DragHandleProps;
  dragHandleClassName?: string;
  /** Withholds every watch affordance while the flag is off. Defaults false until sourced. */
  watchEnabled?: boolean;
  /** The contextual entry point this chat was opened from; drives the header's "Manual setup" action. */
  openSource?: AgentOpenSource;
  /** Prefill for in-place alert creation (from contextual pages). */
  createAlertPrefill?: DraftPrefillParams;
  editAlertRequest?: { prefill: EditAlertPrefill; seq: number };
  // Every `seq` below distinguishes repeat requests with identical contents.
  requestedMessage?: { text: string; seq: number };
  openChatRequest?: { chatId: string; seq: number };
  newChatSeq?: number;
  promotedPrompt?: SuggestedPrompt;
  watchRequest?: { spec: WatchSpec; seq: number };
  onChatRead?: (chatId: string, options: { leaving: boolean }) => void;
  /** How many chats still hold work their owner hasn't seen. */
  onUnreadWorkChange?: (count: number) => void;
  /** Whether a turn is running in a chat, so a closed panel still knows to expect an answer. */
  onTurnActivityChange?: (chatId: string, active: boolean) => void;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { queueMetricsEnabled } = useFeatures();
  const user = useUser();
  const apiOrigin = useDashboardAgentBaseUrl();
  const location = useLocation();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const pageContext = useAgentPageContext();
  const toast = useToast();

  const storageKey = lastChatStorageKey(organization.id);

  const panelRef = useRef<HTMLDivElement | null>(null);
  // Declared before the chat plumbing: changing chat dispatches into it.
  const [watchCard, dispatchWatchCard] = useReducer(watchCardReducer, NO_WATCH_CARD);
  const [chats, setChats] = useState<DashboardAgentChatListItem[]>([]);
  // Until the list has arrived, the page load's server count is the better answer.
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [active, setActive] = useState<ActiveChat | null>(null);
  // A message asked for while the hooks still held the previous project: it is sent once
  // they catch up rather than dropped.
  const [pendingCreate, setPendingCreate] = useState<{
    text: string;
    turnClientData?: DashboardAgentClientData;
  } | null>(null);
  // A refused `create` over the cap: the draft shows the upgrade block instead of a raw
  // toast. Cleared only by a poll newer than `refusalGenRef` — see `handleQuotaChange` below.
  const [capReached, setCapReached] = useState<{ limit: number; planResolved: boolean } | null>(
    null
  );
  // Owned here (survives a chat switch, unlike the chat instance's own state): bumped on
  // every 403, so a poll already in flight when a refusal lands can't be read as proof the
  // cap it just set is gone. Ordered by generation, not the wall clock — two events racing
  // in the same millisecond would otherwise tie under `Date.now()`.
  const refusalGenRef = useRef(0);
  // Starts true so an `openWith` request waits for the restore instead of racing it.
  const [loading, setLoading] = useState(
    () => readLastChat(storageKey)?.path === location.pathname
  );
  const entityId = agentPageEntityId(pageContext, location.pathname);

  const pagePaths = useMemo<Record<string, string>>(
    () => ({ raise_env_limit: concurrencyLimitsPath(organization, project, environment) }),
    [organization, project, environment]
  );

  // A fresh object every render, so the clientData memo keys off the serialized form.
  const pageContextKey = serializePageContext(pageContext);

  // Path and client data come out of one memo: a render can never post to the project it
  // has just left with the data of the one it has arrived at.
  const scope = useMemo(
    () => ({
      actionPath: sessionPathFor(
        { slug: organization.slug },
        { slug: project.slug },
        { slug: environment.slug }
      ),
      clientData: {
        userId: user.id,
        organizationId: organization.id,
        projectId: project.id,
        environmentId: environment.id,
        currentPage: location.pathname,
        pageContext: pageContextKey ? (JSON.parse(pageContextKey) as AgentPageContext) : undefined,
      } satisfies DashboardAgentClientData,
    }),
    [
      user.id,
      organization.id,
      organization.slug,
      project.id,
      project.slug,
      environment.id,
      environment.slug,
      location.pathname,
      pageContextKey,
    ]
  );
  const { actionPath, clientData } = scope;

  const [thinkingChatId, setThinkingChatId] = useState<string | null>(null);
  const handleActivityChange = useCallback(
    (chatId: string, activity: TurnActivity | null) => {
      setThinkingChatId((previous) => markerAfterActivity(previous, chatId, activity));
      onTurnActivityChange?.(chatId, activity !== null);
    },
    [onTurnActivityChange]
  );

  // The read POST and its reload can land out of order, so mask the next list.
  const justRead = useRef<Set<string>>(new Set());

  // Read when the response lands, not when it was requested, so a chat switched to mid-flight
  // is the one the list settles against.
  const visibleChatId = useRef<string | null>(null);

  // Ordering-safe: if the new chat has not reported yet, its own report re-sets the marker.
  useEffect(() => {
    setThinkingChatId((previous) => markerAfterActiveChat(previous, active?.chatId));
  }, [active?.chatId]);

  const loadHistory = useMemo(
    () =>
      createCoalescedReload(async () => {
        try {
          const res = await fetch(actionPath);
          if (!res.ok) throw new Error(`History request failed (${res.status})`);
          const data = (await res.json()) as { chats?: DashboardAgentChatListItem[] };
          const read = justRead.current;
          justRead.current = new Set();
          const chats = data.chats ?? [];
          // Reloaded after every turn and after a watch is created, so this is where the browser
          // learns whether the wake feed is worth polling.
          const pending = chats.some((chat) => chat.hasActiveWatch || chat.hasUnreadWake);
          if (pending) rememberWatchActivity(organization.id);
          else forgetWatchActivity(organization.id);
          const settled = settleReadChats(chats, read, visibleChatId.current);
          setChats(settled);
          setChatsLoaded(true);
        } catch (error) {
          console.error("Dashboard agent: failed to load chat history", error);
          toast.error("We couldn't load your previous chats. Try again in a moment.");
        }
      }),
    [actionPath, organization.id, toast, justRead, visibleChatId]
  );

  // Bumped on each open so a slower earlier open can't overwrite a newer one.
  const openChatRequestSeq = useRef(0);

  // Bound to its chat, which remounts with a fresh guard ref on every switch.
  const [sendRequest, setSendRequest] = useState<
    { text: string; seq: number; chatId: string } | undefined
  >(undefined);

  // The one way the panel changes chat: it invalidates any in-flight open and abandons a
  // half-configured watch card, which would otherwise be submitted against the new chat.
  const claimChatSlot = useCallback(() => {
    dispatchWatchCard({ type: "chat-changed" });
    setCapReached(null);
    setSendRequest(undefined);
    return ++openChatRequestSeq.current;
  }, []);

  const openChat = useCallback(
    async (id: string, stayInCreation = false) => {
      if (!stayInCreation) setCreationMode(false);
      const seq = claimChatSlot();
      setLoading(true);
      try {
        const res = await fetch(`${actionPath}?chatId=${encodeURIComponent(id)}`);
        if (!res.ok && res.status !== 404) {
          console.error(`Dashboard agent: failed to open chat ${id} (${res.status})`);
          toast.error("We couldn't open that chat. Try again in a moment.");
          // Transient failure: keep the stored pointer so the chat can be reopened.
          if (seq === openChatRequestSeq.current) setActive(null);
          return false;
        }
        const data = res.ok ? ((await res.json()) as OpenedChatResponse) : undefined;
        if (seq !== openChatRequestSeq.current) return false;
        const opened = resolveOpenedChat(id, data);
        if (opened.kind === "gone") {
          // Deleted, or another org's: drop the pointer so it can't be restored again.
          setActive(null);
          forgetLastChat(storageKey);
          return false;
        }
        setActive({ ...opened, organizationId: organization.id });
        return true;
      } catch (error) {
        console.error(`Dashboard agent: failed to open chat ${id}`, error);
        toast.error("We couldn't open that chat. Try again in a moment.");
        if (seq === openChatRequestSeq.current) setActive(null);
        return false;
      } finally {
        if (seq === openChatRequestSeq.current) setLoading(false);
      }
    },
    [actionPath, claimChatSlot, organization.id, storageKey, toast]
  );

  const createChat = useCallback(
    async (
      text: string,
      turnClientData?: DashboardAgentClientData
    ): Promise<string | undefined> => {
      // The browser has already moved on; the hooks have not. Creating here would file the
      // chat under the project the user just left, so it waits for them to catch up.
      if (!scopeMatchesPath(location.pathname, actionPath)) {
        setPendingCreate({ text, turnClientData });
        return;
      }
      setPendingCreate(null);
      const seq = claimChatSlot();
      setLoading(true);
      try {
        const userMessage: UIMessage = {
          id: generateFriendlyId("msg"),
          role: "user",
          parts: [{ type: "text", text }],
        };
        const body = new FormData();
        body.set("intent", "create");
        body.set("message", JSON.stringify(userMessage));
        body.set("clientData", JSON.stringify(turnClientData ?? clientData));
        const res = await fetch(actionPath, { method: "POST", body });
        const data = (await res.json()) as {
          chatId?: string;
          publicAccessToken?: string;
          headStarted?: boolean;
          error?: string;
          limit?: number;
        };
        if (seq !== openChatRequestSeq.current) return;
        if (!res.ok || !data.chatId || !data.publicAccessToken) {
          const reached = parseQuotaReachedResponse(res.status, data);
          if (reached) {
            refusalGenRef.current += 1;
            setCapReached(reached);
            setActive(null);
            return;
          }
          console.error(`Dashboard agent: failed to create chat (${res.status})`, data.error);
          toast.error(data.error ?? "We couldn't start that chat. Try again in a moment.");
          setActive(null);
          return;
        }
        setCapReached(null);
        setActive({
          chatId: data.chatId,
          organizationId: organization.id,
          messages: data.headStarted ? [userMessage] : [],
          session: { publicAccessToken: data.publicAccessToken },
          pendingFirstMessage: data.headStarted ? undefined : text,
          streaming: data.headStarted,
        });
        return data.chatId;
      } catch (error) {
        console.error("Dashboard agent: failed to create chat", error);
        toast.error("We couldn't start that chat. Try again in a moment.");
        if (seq === openChatRequestSeq.current) setActive(null);
      } finally {
        if (seq === openChatRequestSeq.current) setLoading(false);
      }
    },
    [actionPath, claimChatSlot, clientData, location.pathname, organization.id, toast]
  );

  useEffect(() => {
    if (pendingCreate === null || !scopeMatchesPath(location.pathname, actionPath)) return;
    void createChat(
      pendingCreate.text,
      rescopeTurnClientData(clientData, pendingCreate.turnClientData)
    );
  }, [pendingCreate, location.pathname, actionPath, createChat, clientData]);

  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    void loadHistory();
    if (creationModeRef.current) {
      setLoading(false);
    } else {
      const stored = readLastChat(storageKey);
      if (stored && stored.path === location.pathname) {
        void openChat(stored.chatId);
      } else {
        setLoading(false);
      }
    }
    // location is deliberately not a dep: this is a mount-time decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openChat, storageKey, loadHistory]);

  // Crossing into another org does not remount the layout.
  const panelOrg = useRef(organization.id);
  useEffect(() => {
    if (panelOrg.current === organization.id) return;
    panelOrg.current = organization.id;
    claimChatSlot();
    setActive(null);
    setCapReached(null);
    setLoading(false);
    setChats([]);
    setChatsLoaded(false);
    void loadHistory();
  }, [organization.id, claimChatSlot, loadHistory]);

  const handledOpenChatSeq = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!openChatRequest || handledOpenChatSeq.current === openChatRequest.seq) return;
    handledOpenChatSeq.current = openChatRequest.seq;
    // Reloading the visible transcript would drop a turn in flight.
    if (openChatRequest.chatId === active?.chatId) return;

    void openChat(openChatRequest.chatId);
    // `active` is read, not tracked: a later change must not re-run the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openChatRequest, openChat]);

  useEffect(() => {
    if (!shouldPersistLastChat(active, organization.id)) return;
    writeLastChat(storageKey, { chatId: active.chatId, path: location.pathname });
  }, [active, organization.id, storageKey, location.pathname]);

  useEffect(() => {
    if (!active?.chatId) return;
    const chatId = active.chatId;
    onChatRead?.(chatId, { leaving: false });
    visibleChatId.current = nextVisibleChat(chatId, { leaving: false });
    justRead.current.add(chatId);

    setChats((previous) => markChatListRead(previous, chatId));
    // Read again on the way out: a wake can land while the chat is open.
    return () => {
      onChatRead?.(chatId, { leaving: true });
      visibleChatId.current = nextVisibleChat(chatId, { leaving: true });
      justRead.current.add(chatId);
      setChats((previous) => markChatListRead(previous, chatId));
    };
  }, [active?.chatId, onChatRead]);

  // The one source for the dot's work count: nudging it per open double-subtracts.
  useEffect(() => {
    if (!chatsLoaded) return;
    onUnreadWorkChange?.(unreadWorkCount(chats, active?.chatId));
  }, [chats, chatsLoaded, active?.chatId, onUnreadWorkChange]);

  const [creationMode, setCreationMode] = useState(openSource === "alerts");
  const [dismissedEditSeq, setDismissedEditSeq] = useState<number>();
  const activeEdit =
    editAlertRequest && editAlertRequest.seq !== dismissedEditSeq ? editAlertRequest : undefined;
  const activeEditRef = useRef(activeEdit);
  activeEditRef.current = activeEdit;
  const inEditMode = Boolean(activeEdit);
  const inCreationMode = creationMode && !inEditMode;
  const creationModeRef = useRef(creationMode);
  creationModeRef.current = creationMode;

  const [slackResume, setSlackResume] = useState(() =>
    openSource === "alerts" && new URLSearchParams(location.search).get("add") === "slack"
      ? readSlackConnectResume(project.id, environment.id)
      : undefined
  );
  const [creationDraft, setCreationDraft] = useState(() =>
    slackResume
      ? (({ manual: _manual, ...answers }) => ({ ...answers, expiry: undefined }))(slackResume)
      : openSource === "alerts"
        ? createAlertPrefill
          ? prefillToAnswers(createAlertPrefill)
          : draftFromSearch(location.search, true)
        : undefined
  );
  const [creationEntrySeq, setCreationEntrySeq] = useState(0);
  const [creationGeneration, setCreationGeneration] = useState(0);
  const creationAgentChat = useRef<CreationAgentChat>({ seq: -1 });
  const [manualMode, setManualMode] = useState(Boolean(slackResume?.manual));

  const createParamKey = inCreationMode ? createSearchKey(location.search) : "";
  const prevCreateParamKeyRef = useRef(createParamKey);
  const prevPrefillRef = useRef(createAlertPrefill);

  const prevOpenSourceRef = useRef(openSource);
  if (prevOpenSourceRef.current !== openSource || prevPrefillRef.current !== createAlertPrefill) {
    prevOpenSourceRef.current = openSource;
    prevPrefillRef.current = createAlertPrefill;
    if (openSource === "alerts") {
      setCreationMode(true);
      setManualMode(false);
      const draft = createAlertPrefill
        ? prefillToAnswers(createAlertPrefill)
        : draftFromSearch(location.search, true);
      setCreationDraft(draft);
      prevCreateParamKeyRef.current = createSearchKey(location.search);
      setCreationEntrySeq((s) => s + 1);
      setCreationGeneration((g) => g + 1);
      creationAgentChat.current = { seq: -1 };
    } else {
      setCreationMode(false);
      setCreationDraft(undefined);
      prevCreateParamKeyRef.current = "";
    }
  } else if (
    inCreationMode &&
    !createAlertPrefill &&
    createParamKey !== prevCreateParamKeyRef.current
  ) {
    prevCreateParamKeyRef.current = createParamKey;
    setManualMode(false);
    setCreationDraft(draftFromSearch(location.search, true));
    setCreationEntrySeq((s) => s + 1);
    setCreationGeneration((g) => g + 1);
    creationAgentChat.current = { seq: -1 };
  }

  const doCreateSession = useCallback(
    async (signal: AbortSignal): Promise<string | undefined> => {
      const body = new FormData();
      body.set("intent", "create-session");
      const res = await fetch(actionPath, { method: "POST", body, signal });
      if (signal.aborted) return undefined;
      const data = (await res.json()) as { chatId?: string };
      return res.ok ? data.chatId : undefined;
    },
    [actionPath]
  );
  const doDiscardSession = useCallback(
    (chatId: string) => {
      const body = new FormData();
      body.set("intent", "delete");
      body.set("chatId", chatId);
      void fetch(actionPath, { method: "POST", body }).catch(() => {});
    },
    [actionPath]
  );
  const creationSession = useCreationSession({
    enabled: inCreationMode,
    createSession: doCreateSession,
    discardSession: doDiscardSession,
    generation: creationGeneration,
  });
  const creationChatId = creationSession.chatId;
  const creationEntrySeqRef = useRef(creationEntrySeq);
  creationEntrySeqRef.current = creationEntrySeq;

  const handledRequestSeq = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!requestedMessage || handledRequestSeq.current === requestedMessage.seq) return;
    if (creationModeRef.current) {
      handledRequestSeq.current = requestedMessage.seq;
      return;
    }
    const target = explicitPromptTarget({
      chat: loading ? "opening" : active ? "open" : "none",
      turnInFlight: thinkingChatId !== null && thinkingChatId === active?.chatId,
    });
    // Held requests are re-asked by this same effect once the panel settles.
    if (target === "hold") return;
    handledRequestSeq.current = requestedMessage.seq;
    if (target === "new-chat") {
      void createChat(requestedMessage.text);
      return;
    }
    setSendRequest({ ...requestedMessage, chatId: active!.chatId });
  }, [requestedMessage, loading, active, thinkingChatId, createChat]);

  // Carries its chat id so a later-mounted chat cannot adopt another chat's block.
  const [appendedMessages, setAppendedMessages] = useState<
    { chatId: string; messages: UIMessage[]; seq: number } | undefined
  >(undefined);

  const handledWatchSeq = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!watchEnabled || !watchRequest || handledWatchSeq.current === watchRequest.seq) return;
    handledWatchSeq.current = watchRequest.seq;
    dispatchWatchCard({
      type: "open",
      draft: watchDraftFor(watchRequest.spec),
      requestId: generateFriendlyId("wreq"),
    });
  }, [watchRequest, watchEnabled]);

  // Nothing is posted or persisted until the card is submitted.
  const openWatchCard = useCallback(
    (spec: WatchSpec) => {
      if (!watchEnabled) return;
      dispatchWatchCard({
        type: "open",
        draft: watchDraftFor(spec),
        requestId: generateFriendlyId("wreq"),
      });
    },
    [watchEnabled]
  );

  const dismissWatchCard = () => dispatchWatchCard({ type: "dismissed" });
  const activeChatId = active?.chatId;

  const submitWatch = useCallback(async () => {
    const draft = watchCard.draft;
    if (!draft) return;
    // Held across retries, so a resubmit repairs the same pair of records.
    const clientRequestId = watchCard.requestId ?? generateFriendlyId("wreq");
    dispatchWatchCard({ type: "submitting", requestId: clientRequestId });
    try {
      const body = new FormData();
      body.set("intent", "watch-create");
      body.set("draft", JSON.stringify(draft));
      body.set("clientRequestId", clientRequestId);
      // A watch is chat-bound: with no chat open the server creates one.
      if (activeChatId) body.set("chatId", activeChatId);

      const res = await fetch(actionPath, { method: "POST", body });
      const data = (await res.json()) as {
        chatId?: string;
        messages?: UIMessage[];
        error?: string;
      };
      if (!res.ok || !data.chatId || !data.messages) {
        dispatchWatchCard({
          type: "failed",
          error: data.error ?? "We couldn't start that watch. Try again in a moment.",
        });
        return;
      }

      const messages = data.messages;
      if (activeChatId === data.chatId) {
        setAppendedMessages((current) => ({
          chatId: data.chatId!,
          messages,
          seq: (current?.seq ?? 0) + 1,
        }));
        dispatchWatchCard({ type: "submitted" });
      } else {
        claimChatSlot();
        // No session: nothing is streaming and the records are the whole chat.
        setActive({
          chatId: data.chatId,
          messages,
          session: null,
          organizationId: organization.id,
        });
      }
      void loadHistory();
    } catch (error) {
      console.error("Dashboard agent: failed to create watch", error);
      dispatchWatchCard({
        type: "failed",
        error: "We couldn't start that watch. Try again in a moment.",
      });
    }
  }, [
    watchCard.draft,
    watchCard.requestId,
    activeChatId,
    actionPath,
    organization.id,
    claimChatSlot,
    loadHistory,
  ]);

  const watchCardElement =
    watchEnabled && watchCard.draft ? (
      <WatchCard
        draft={watchCard.draft}
        onChange={(draft) => dispatchWatchCard({ type: "edit", draft })}
        onSubmit={() => void submitWatch()}
        onCancel={dismissWatchCard}
        pending={watchCard.pending}
        error={watchCard.error}
      />
    ) : null;

  const newChat = useCallback(() => {
    setDismissedEditSeq(activeEditRef.current?.seq);
    setCreationMode(false);
    claimChatSlot();
    setLoading(false);
    setActive(null);
    forgetLastChat(storageKey);
  }, [claimChatSlot, storageKey]);

  const restartCreation = useCallback(() => {
    newChat();
    setCreationMode(true);
    setCreationDraft(draftFromSearch(location.search, true));
    setCreationEntrySeq((s) => s + 1);
    setCreationGeneration((g) => g + 1);
  }, [newChat, location.search]);

  // Released only by a read that proves capacity: an unknown quota keeps the block.
  // Only a poll newer than the latest refusal (`quota.pollIsFresh`) may lift it — see
  // `refusalGenRef` above.
  const handleQuotaChange = useCallback(
    (quota: MessageQuota & { pollIsFresh: boolean; provenCapacity: boolean }) => {
      setCapReached((current) =>
        current && quota.pollIsFresh && shouldClearCapReached(quota) ? null : current
      );
    },
    []
  );

  const switchChat = useCallback(
    (id: string) => {
      void openChat(id);
    },
    [openChat]
  );

  // The ref skips the mount-time value so opening the panel never resets a restored chat.
  const seenNewChatSeq = useRef(newChatSeq ?? 0);
  useEffect(() => {
    if (newChatSeq === undefined || newChatSeq === seenNewChatSeq.current) return;
    seenNewChatSeq.current = newChatSeq;
    newChat();
  }, [newChatSeq, newChat]);

  const deleteChat = useCallback(
    async (id: string) => {
      const body = new FormData();
      body.set("intent", "delete");
      body.set("chatId", id);
      try {
        const res = await fetch(actionPath, { method: "POST", body });
        if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      } catch (error) {
        console.error("Dashboard agent: failed to delete chat", error);
        toast.error("We couldn't delete that chat. Try again in a moment.");
        return;
      }
      setThinkingChatId((previous) => (previous === id ? null : previous));
      if (id === active?.chatId) newChat();
      void loadHistory();
    },
    [actionPath, active?.chatId, newChat, loadHistory, toast]
  );

  const cancelWatch = useCallback(
    async (watchId: string) => {
      const chatId = active?.chatId;
      if (!chatId) return;
      setChats((previous) =>
        previous.map((chat) =>
          chat.id === chatId
            ? { ...chat, watches: (chat.watches ?? []).filter((watch) => watch.id !== watchId) }
            : chat
        )
      );
      const body = new FormData();
      body.set("intent", "watch-cancel");
      body.set("chatId", chatId);
      body.set("watchId", watchId);
      try {
        const res = await fetch(actionPath, { method: "POST", body });
        if (!res.ok) throw new Error(`Watch cancel failed (${res.status})`);
        // Empty when the watch had already resolved: then nothing was written.
        const data = (await res.json()) as { messages?: UIMessage[] };
        if (data.messages?.length) {
          const messages = data.messages;
          setAppendedMessages((current) => ({
            chatId,
            messages,
            seq: (current?.seq ?? 0) + 1,
          }));
        }
      } catch (error) {
        console.error("Dashboard agent: failed to cancel watch", error);
        toast.error("We couldn't stop that watch. Try again in a moment.");
      }
      void loadHistory();
    },
    [actionPath, active?.chatId, loadHistory, toast]
  );

  // Titles are written when the first turn settles, so a new chat has none yet.
  const activeChat = active ? chats.find((chat) => chat.id === active.chatId) : undefined;
  const activeChatClientData = useMemo(
    () => chatTurnClientData(clientData, activeChat?.kind),
    [clientData, activeChat?.kind]
  );

  // Not filtered to active: the wake banner needs watches that already fired.
  const chatWatches = activeChat?.watches ?? [];

  const submitReplace = useCallback(
    async (answers: FlowAnswers, chatId: string | undefined, expiresAt: string | undefined) => {
      const target = answers.replace!;
      const body = new FormData();
      body.set("intent", "replace");
      body.set("channelId", target.channelId);
      body.set("alertType", target.alertType);
      body.set("environmentIds", (answers.environments ?? []).join(","));
      body.set("value", answers.condition ?? "0");
      if (answers.windowMinutes) body.set("windowMinutes", String(answers.windowMinutes));
      if (expiresAt) body.set("expiresAt", expiresAt);
      if (answers.scope) body.set("scopeType", answers.scope);
      if (answers.scopeValue) body.set("scopeValue", answers.scopeValue);
      body.set(
        "notifierChannelIds",
        (answers.notifiers ?? []).filter((n) => n !== "chat").join(",")
      );
      if (chatId) body.set("chatId", chatId);
      try {
        const res = await fetch(
          `${v3ProjectLegacyAlertsPath(organization, project, environment)}?_data=${encodeURIComponent(LEGACY_ALERTS_ROUTE_ID)}`,
          { method: "POST", body }
        );
        const data = (await res.json()) as {
          message?: string;
          error?: string;
          legacyRemaining?: boolean;
        };
        if (!res.ok || !data.message) {
          toast.error(data.error ?? "Failed to replace the legacy alert. Try again.");
          return false;
        }
        const alertsPath = v3ProjectAlertsPath(organization, project, environment);
        toast.success(data.message, {
          action: { label: "View alerts", action: { type: "link", path: alertsPath } },
        });
        afterReplace(data.legacyRemaining, alertsPath, navigate, () => revalidator.revalidate());
        onClose();
        return true;
      } catch {
        return false;
      }
    },
    [organization, project, environment, navigate, revalidator, toast, onClose]
  );
  const handleAlertCreated = useCallback(
    async (
      answers: FlowAnswers
    ): Promise<{ ok: CreationResult; chatId?: string; release?: () => void }> => {
      const seq = creationEntrySeqRef.current;
      let release: (() => void) | undefined;
      try {
        const cap = resolveCapability(answers.what);
        const kind = cap?.allowedKinds[0] ?? "threshold";
        const notifierIds = (answers.notifiers ?? []).filter((n) => n !== "chat");
        const wantsChat = (answers.notifiers ?? []).includes("chat");
        const reused = creationChatToReuse(
          creationAgentChat.current,
          creationEntrySeq,
          active?.chatId
        );
        const transcriptChatId =
          wantsChat || !answers.replace ? (reused ?? (await creationSession.ensure())) : undefined;
        const effectiveChatId = wantsChat ? transcriptChatId : undefined;
        if (!reused && transcriptChatId && seq === creationEntrySeqRef.current) {
          release = creationSession.keep();
        }
        if (wantsChat && !effectiveChatId) {
          toast.error("We couldn't set up this chat to receive the alert. Try again.");
          return { ok: false };
        }
        const wantChat = wantsChat;

        const expiresAt = expiryToIso(answers.expiry);
        if (answers.replace) {
          return {
            ok: await submitReplace(answers, effectiveChatId, expiresAt),
            chatId: transcriptChatId,
            release,
          };
        }

        const resp = await fetch("/resources/alerts/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId: organization.id,
            projectId: project.id,
            environmentId: environment.id,
            name: alertName(answers),
            chatNotifier: wantChat ? "on" : undefined,
            chatId: wantChat ? effectiveChatId : undefined,
            transcriptChatId,
            expiry:
              answers.expiry && EXPIRY_TOKEN_PATTERN.test(answers.expiry)
                ? answers.expiry
                : undefined,
            form: {
              capabilityKey: answers.what,
              scopeType: answers.scope,
              scopeValue: answers.scopeValue,
              conditionKind: kind,
              operator: kind === "threshold" ? ">" : undefined,
              value: answers.condition ? Number(answers.condition) : undefined,
              windowMinutes:
                kind === "threshold"
                  ? (answers.windowMinutes ?? defaultWindowMinutes(answers.what))
                  : undefined,
              quietWindowMinutes:
                kind === "absence" && answers.condition ? Number(answers.condition) : undefined,
              conditionParams:
                kind === "state" && answers.conditionParams ? answers.conditionParams : undefined,
              expiresAt,
              notifierChannelIds: notifierIds,
            },
          }),
        });
        if (!resp.ok) return { ok: false, release };
        const data = (await resp.json()) as { alertId?: string; message?: AlertCreatedMessage };
        revalidator.revalidate();
        const message = data.message;
        if (message && transcriptChatId) {
          setAppendedMessages((current) => ({
            chatId: transcriptChatId,
            messages: [message as UIMessage],
            seq: (current?.seq ?? 0) + 1,
          }));
        }
        if (!data.alertId) return { ok: true, chatId: transcriptChatId };
        return {
          ok: { alertId: data.alertId, block: message?.parts[1].data.blocks[0] },
          chatId: transcriptChatId,
        };
      } catch {
        return { ok: false, release };
      }
    },
    [
      organization.id,
      project.id,
      environment.id,
      active?.chatId,
      creationEntrySeq,
      creationSession,
      revalidator,
      submitReplace,
      toast,
    ]
  );

  const creationFlow = useCreationFlowState(
    async (answers: FlowAnswers) => {
      const { ok, chatId, release } = await handleAlertCreated(answers);
      if (ok) {
        if (chatId) {
          const body = new FormData();
          body.set("intent", "rename");
          body.set("chatId", chatId);
          body.set("title", alertName(answers));
          void fetch(actionPath, { method: "POST", body }).catch(() => {});
        }
      } else {
        release?.();
      }
      return ok;
    },
    creationDraft,
    creationEntrySeq
  );

  const { setExpiry } = creationFlow;
  useEffect(() => {
    if (!slackResume) return;
    clearSlackConnectResume(project.id, environment.id);
    if (slackResume.expiry) setExpiry(slackResume.expiry);
    const params = new URLSearchParams(location.search);
    params.delete("add");
    params.delete("create");
    navigate({ search: params.toString() }, { replace: true });
  }, [slackResume, project.id, environment.id, setExpiry]); // eslint-disable-line react-hooks/exhaustive-deps -- once per resume

  const creationTitle = creationFlow.created ? "Alert created" : "New alert";
  const headerTitle = inEditMode
    ? "Edit alert"
    : inCreationMode
      ? creationTitle
      : active
        ? (activeChat?.title ?? "Chat")
        : "New chat";

  const errorGroupSource = useErrorGroupSource(
    `/resources${v3EnvironmentPath(organization, project, environment)}/alerts/error-groups`,
    inCreationMode && isErrorGroupOnly(creationFlow.answers.what)
  );
  const creationAgentSend = useCreationAgentSend({
    answers: creationFlow.answers,
    onPatchApplied: creationFlow.patchAnswers,
    resetKey: creationEntrySeq,
    resolveErrorGroup: errorGroupSource.resolve,
  });

  const { handleDraftPatches, handleTextReply, handleError } = creationAgentSend;
  const creationCallbacks = useMemo(() => {
    const current = () =>
      creationAgentChat.current.seq === creationEntrySeqRef.current &&
      creationAgentChat.current.chatId === activeChatId;
    return {
      onAlertDraftPatch: (results: ToolResultPayload[]) => {
        if (current()) handleDraftPatches(results);
      },
      onCreationTextReply: (text: string) => {
        if (current()) handleTextReply(text);
      },
      onTurnError: (message: string) => {
        if (current()) handleError(message);
      },
    };
  }, [activeChatId, handleDraftPatches, handleTextReply, handleError]);

  const creationClientData = useMemo(
    () => creationTurnClientData(clientData, creationFlow.answers),
    [clientData, creationFlow.answers]
  );
  const creationSendSeq = useRef(0);
  const sendCreationText = (text: string) => {
    creationAgentSend.handleUserText(text);
    const reuse = creationChatToReuse(creationAgentChat.current, creationEntrySeq, active?.chatId);
    if (reuse) {
      setSendRequest({ text, seq: ++creationSendSeq.current, chatId: reuse });
      return;
    }
    const seq = creationEntrySeq;
    const marked = creationAgentChat.current;
    if (marked.seq === seq && marked.chatId && (loading || !active)) {
      setSendRequest({ text, seq: ++creationSendSeq.current, chatId: marked.chatId });
      return;
    }
    void (async () => {
      const chatId = await creationSession.ensure().catch(() => undefined);
      if (creationEntrySeqRef.current !== seq) return;
      if (!chatId) {
        toast.error("We couldn't start that chat. Try again in a moment.");
        creationAgentSend.handleError("We couldn't start that chat. Try again in a moment.");
        return;
      }
      const release = creationSession.keep();
      creationAgentChat.current = { seq, chatId };
      const opened = await openChat(chatId, true).catch(() => false);
      if (!opened) release();
      if (creationEntrySeqRef.current !== seq) return;
      if (!opened) {
        creationAgentChat.current = { seq: -1 };
        creationAgentSend.handleError("We couldn't open that chat. Try again in a moment.");
        return;
      }
      setSendRequest({ text, seq: ++creationSendSeq.current, chatId });
    })();
  };

  const channelsFetcher = useFetcher<{
    channels: AlertChannel[];
    canWrite?: boolean;
    limits?: { used: number; limit: number };
  }>();
  const channelsFetchedRef = useRef(false);
  useEffect(() => {
    if ((inCreationMode || inEditMode) && !channelsFetchedRef.current) {
      channelsFetchedRef.current = true;
      channelsFetcher.load(alertChannelsResourcePath(project.id, false, environment.id));
    }
    if (!inCreationMode && !inEditMode) {
      channelsFetchedRef.current = false;
    }
  }, [inCreationMode, inEditMode, project.id, environment.id]); // eslint-disable-line -- fetcher is stable
  const alertChannels: AlertChannel[] = channelsFetcher.data?.channels ?? [];
  const channelLimits = channelsFetcher.data?.limits;
  const addChannelAccess = {
    projectId: project.id,
    environmentId: environment.id,
    canWrite: channelsFetcher.data?.canWrite ?? false,
    atLimit: channelLimits ? channelLimits.used >= channelLimits.limit : false,
    onCreated: () =>
      channelsFetcher.load(alertChannelsResourcePath(project.id, false, environment.id)),
    connectReturnTo: `${v3AlertCreatePath(organization, project, environment)}&add=slack`,
  };

  /* oxlint-disable jsx-a11y/no-static-element-interactions -- Escape handling intentionally bubbles from focused controls inside the panel. */
  return (
    <div
      ref={panelRef}
      data-agent-panel="visible"
      className="flex h-full flex-col bg-background-bright animate-in fade-in zoom-in-95 duration-150"
      // A React handler, not a global hotkey, so Esc stays scoped to the panel.
      onKeyDown={(event) => {
        if (
          !escapeClosesPanel({
            key: event.key,
            defaultPrevented: event.defaultPrevented,
            targetInsidePanel: panelRef.current?.contains(event.target as Node) ?? false,
            targetInDialog: Boolean((event.target as Element).closest?.("[data-dialog]")),
            targetExpanded: ownsEscape(event.target as Element),
          })
        )
          return;
        event.preventDefault();
        onClose();
      }}
    >
      <motion.div {...dragHandleProps} className={dragHandleClassName}>
        <DashboardAgentHeader
          title={headerTitle}
          chats={chats}
          currentChatId={active?.chatId ?? ""}
          onOpenHistory={loadHistory}
          onSelectChat={switchChat}
          onDeleteChat={deleteChat}
          mode={mode}
          onModeChange={onModeChange ?? (() => {})}
          onClose={onClose}
        />
      </motion.div>

      {/* Always mounted, so the chat keeps its transport, session and transcript. */}
      <AgentPanelColumn fullscreen={mode === "fullscreen"}>
        {activeEdit && !loading ? (
          <CreationChatShell placement="docked" title="Edit alert">
            <EditAlertTranscript
              key={activeEdit.seq}
              prefill={activeEdit.prefill}
              userId={user.id}
              onNewChat={newChat}
              channels={alertChannels}
              alertPath={v3AlertPath(
                organization,
                project,
                environment,
                activeEdit.prefill.alertId
              )}
              addChannel={addChannelAccess}
            />
          </CreationChatShell>
        ) : null}
        {inCreationMode ? (
          <CreationChatShell placement="docked" title={creationTitle}>
            <CreationTranscript
              key={creationEntrySeq}
              queueMetricsEnabled={queueMetricsEnabled}
              flow={creationFlow}
              channels={alertChannels}
              chatId={creationChatId ?? active?.chatId ?? CHAT_CREATED_ON_USE}
              alertDetailPath={(id) => v3AlertPath(organization, project, environment, id)}
              onFreeText={sendCreationText}
              systemLines={creationAgentSend.systemLines}
              agentStreaming={thinkingChatId !== null && thinkingChatId === active?.chatId}
              manual={manualMode}
              onManualChange={setManualMode}
              onNewChat={restartCreation}
              density="compact"
              addChannel={{
                ...addChannelAccess,
                resumed: Boolean(slackResume) && creationEntrySeq === 0,
                onResumeConsumed: () => setSlackResume(undefined),
              }}
              errorGroupSource={errorGroupSource}
              environmentTitle={environmentFullTitle(environment)}
            />
          </CreationChatShell>
        ) : null}
        {loading ? (
          inCreationMode ? null : (
            <div className="flex flex-1 items-center justify-center">
              <Spinner className="size-5" />
            </div>
          )
        ) : active ? (
          <DashboardAgentChat
            key={active.chatId}
            chatId={active.chatId}
            initialMessages={active.messages}
            session={active.session}
            pendingFirstMessage={active.pendingFirstMessage}
            streaming={active.streaming}
            sendRequest={
              sendRequest && sendRequest.chatId === active.chatId ? sendRequest : undefined
            }
            clientData={inCreationMode ? creationClientData : activeChatClientData}
            apiOrigin={apiOrigin}
            actionPath={actionPath}
            projectName={project.name}
            environmentSlug={environment.slug}
            entityId={entityId}
            promotedPrompt={promotedPrompt}
            watches={chatWatches}
            pagePaths={pagePaths}
            watchCard={watchCardElement}
            appendedMessages={
              appendedMessages?.chatId === active.chatId ? appendedMessages : undefined
            }
            onWatchIntent={openWatchCard}
            onCancelWatch={cancelWatch}
            onTurnSettled={loadHistory}
            onAlertDraftPatch={inCreationMode ? creationCallbacks.onAlertDraftPatch : undefined}
            onCreationTextReply={inCreationMode ? creationCallbacks.onCreationTextReply : undefined}
            onTurnError={inCreationMode ? creationCallbacks.onTurnError : undefined}
            onActivityChange={handleActivityChange}
            onQuotaChange={handleQuotaChange}
            refusalGenRef={refusalGenRef}
            onNewChat={newChat}
            showNewChat={active !== null}
            watchEnabled={watchEnabled}
            headless={inCreationMode || inEditMode}
          />
        ) : inCreationMode || inEditMode ? null : (
          <>
            {capReached ? (
              <DraftQuotaPoller
                actionPath={actionPath}
                refusalGenRef={refusalGenRef}
                onQuotaChange={handleQuotaChange}
              />
            ) : null}
            <DashboardAgentDraft
              onSubmit={createChat}
              projectName={project.name}
              environmentSlug={environment.slug}
              entityId={entityId}
              pageContext={pageContext}
              promotedPrompt={promotedPrompt}
              watchCard={watchCardElement}
              capReached={capReached}
              watchEnabled={watchEnabled}
            />
          </>
        )}
      </AgentPanelColumn>
    </div>
  );
}
/* oxlint-enable jsx-a11y/no-static-element-interactions */
