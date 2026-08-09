import type { UIMessage } from "@ai-sdk/react";
import { useLocation } from "@remix-run/react";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentSpinner } from "~/components/primitives/Spinner";
import { useToast } from "~/components/primitives/Toast";
import { useAgentPageContext } from "~/hooks/useAgentPageContext";
import { useApiOrigin } from "~/hooks/useApiOrigin";
import { useEnvironment } from "~/hooks/useEnvironment";
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
import type { TurnActivity } from "./DashboardAgentMessages";
import { DashboardAgentHeader } from "./DashboardAgentHeader";
import type { DashboardAgentChat as DashboardAgentChatListItem } from "./DashboardAgentHistory";
import type { SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { resolveOpenedChat, type OpenedChatResponse } from "./opened-chat";
import type { AgentPageContext } from "./page-context-types";
import { agentPageLabel } from "./page-label";
import { AgentPanelColumn } from "./panel-layout";
import { concurrencyPath } from "~/utils/pathBuilder";

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

// The server generates the chat id on the first send; the client never invents one.
export function DashboardAgentPanel({
  onClose,
  requestedMessage,
  newChatSeq,
  promotedPrompt,
  isFullscreen = false,
  onToggleFullscreen,
}: {
  onClose: () => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  // Every `seq` below distinguishes repeat requests with identical contents.
  requestedMessage?: { text: string; seq: number };
  newChatSeq?: number;
  promotedPrompt?: SuggestedPrompt;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const user = useUser();
  const apiOrigin = useApiOrigin();
  const location = useLocation();
  const pageContext = useAgentPageContext();
  const toast = useToast();

  const actionPath = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/dashboard-agent`;
  const storageKey = lastChatStorageKey(organization.id);

  const [chats, setChats] = useState<DashboardAgentChatListItem[]>([]);
  const [active, setActive] = useState<ActiveChat | null>(null);
  // Starts true so an `openWith` request waits for the restore instead of racing it.
  const [loading, setLoading] = useState(
    () => readLastChat(storageKey)?.path === location.pathname
  );

  const currentPage = agentPageLabel(pageContext, location.pathname);

  const pagePaths = useMemo<Record<string, string>>(
    () => ({ raise_env_limit: concurrencyPath(organization, project, environment) }),
    [organization, project, environment]
  );

  // A fresh object every render, so the clientData memo keys off the serialized form.
  const pageContextKey = serializePageContext(pageContext);

  const clientData = useMemo<DashboardAgentClientData>(
    () => ({
      userId: user.id,
      organizationId: organization.id,
      projectId: project.id,
      environmentId: environment.id,
      currentPage: location.pathname,
      pageContext: pageContextKey ? (JSON.parse(pageContextKey) as AgentPageContext) : undefined,
    }),
    [user.id, organization.id, project.id, environment.id, location.pathname, pageContextKey]
  );

  const [thinkingChatId, setThinkingChatId] = useState<string | null>(null);
  const handleActivityChange = useCallback((chatId: string, activity: TurnActivity | null) => {
    setThinkingChatId((previous) =>
      activity !== null ? chatId : previous === chatId ? null : previous
    );
  }, []);

  const loadHistory = useMemo(
    () =>
      createCoalescedReload(async () => {
        try {
          const res = await fetch(actionPath);
          if (!res.ok) throw new Error(`History request failed (${res.status})`);
          const data = (await res.json()) as { chats?: DashboardAgentChatListItem[] };
          setChats(data.chats ?? []);
        } catch (error) {
          console.error("Dashboard agent: failed to load chat history", error);
          toast.error("We couldn't load your previous chats. Try again in a moment.");
        }
      }),
    [actionPath, toast]
  );

  // Bumped on each open so a slower earlier open can't overwrite a newer one.
  const openChatRequestSeq = useRef(0);

  const openChat = useCallback(
    async (id: string) => {
      const seq = ++openChatRequestSeq.current;
      setLoading(true);
      try {
        const res = await fetch(`${actionPath}?chatId=${encodeURIComponent(id)}`);
        if (!res.ok && res.status !== 404) {
          console.error(`Dashboard agent: failed to open chat ${id} (${res.status})`);
          toast.error("We couldn't open that chat. Try again in a moment.");
        }
        const data = res.ok ? ((await res.json()) as OpenedChatResponse) : undefined;
        if (seq !== openChatRequestSeq.current) return;
        const opened = resolveOpenedChat(id, data);
        if (opened.kind === "gone") {
          // Deleted, or another org's: drop the pointer so it can't be restored again.
          setActive(null);
          forgetLastChat(storageKey);
          return;
        }
        setActive({ ...opened, organizationId: organization.id });
      } catch (error) {
        console.error(`Dashboard agent: failed to open chat ${id}`, error);
        toast.error("We couldn't open that chat. Try again in a moment.");
        if (seq === openChatRequestSeq.current) setActive(null);
      } finally {
        if (seq === openChatRequestSeq.current) setLoading(false);
      }
    },
    [actionPath, organization.id, storageKey, toast]
  );

  const createChat = useCallback(
    async (text: string) => {
      const seq = ++openChatRequestSeq.current;
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
        body.set("clientData", JSON.stringify(clientData));
        const res = await fetch(actionPath, { method: "POST", body });
        const data = (await res.json()) as {
          chatId?: string;
          publicAccessToken?: string;
          headStarted?: boolean;
          error?: string;
        };
        if (seq !== openChatRequestSeq.current) return;
        if (!res.ok || !data.chatId || !data.publicAccessToken) {
          console.error(`Dashboard agent: failed to create chat (${res.status})`, data.error);
          toast.error(data.error ?? "We couldn't start that chat. Try again in a moment.");
          setActive(null);
          return;
        }
        setActive({
          chatId: data.chatId,
          organizationId: organization.id,
          messages: data.headStarted ? [userMessage] : [],
          session: { publicAccessToken: data.publicAccessToken },
          pendingFirstMessage: data.headStarted ? undefined : text,
          streaming: data.headStarted,
        });
      } catch (error) {
        console.error("Dashboard agent: failed to create chat", error);
        toast.error("We couldn't start that chat. Try again in a moment.");
        if (seq === openChatRequestSeq.current) setActive(null);
      } finally {
        if (seq === openChatRequestSeq.current) setLoading(false);
      }
    },
    [actionPath, clientData, organization.id, toast]
  );

  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    void loadHistory();
    const stored = readLastChat(storageKey);
    if (stored && stored.path === location.pathname) {
      void openChat(stored.chatId);
    } else {
      setLoading(false);
    }
    // location is deliberately not a dep: this is a mount-time decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openChat, storageKey, loadHistory]);

  // Crossing into another org does not remount the layout.
  const panelOrg = useRef(organization.id);
  useEffect(() => {
    if (panelOrg.current === organization.id) return;
    panelOrg.current = organization.id;
    openChatRequestSeq.current += 1;
    setActive(null);
    setLoading(false);
    setChats([]);
    void loadHistory();
  }, [organization.id, loadHistory]);

  useEffect(() => {
    if (!shouldPersistLastChat(active, organization.id)) return;
    writeLastChat(storageKey, { chatId: active.chatId, path: location.pathname });
  }, [active, organization.id, storageKey, location.pathname]);

  // Bound to its chat, which remounts with a fresh guard ref on every switch.
  const [prefill, setPrefill] = useState<{ text: string; seq: number; chatId: string } | undefined>(
    undefined
  );
  const handledRequestSeq = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!requestedMessage || loading) return;
    if (handledRequestSeq.current === requestedMessage.seq) return;
    handledRequestSeq.current = requestedMessage.seq;
    if (active) {
      setPrefill({ ...requestedMessage, chatId: active.chatId });
    } else {
      void createChat(requestedMessage.text);
    }
  }, [requestedMessage, loading, active, createChat]);

  const newChat = useCallback(() => {
    // Invalidate any in-flight open or create so its result can't replace the draft.
    openChatRequestSeq.current += 1;
    setLoading(false);
    setActive(null);
  }, []);

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

  // Titles are written when the first turn settles, so a new chat has none yet.
  const activeChat = active ? chats.find((chat) => chat.id === active.chatId) : undefined;
  const headerTitle = active ? (activeChat?.title ?? "Chat") : "New chat";

  return (
    <div
      className="flex h-full flex-col bg-background-bright animate-in slide-in-from-right-2 duration-150"
      // A React handler, not a global hotkey, so Esc stays scoped to the panel.
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
      }}
    >
      <DashboardAgentHeader
        title={headerTitle}
        chats={chats}
        currentChatId={active?.chatId ?? ""}
        thinkingChatId={thinkingChatId}
        onNewChat={newChat}
        showNewChat={active !== null}
        onOpenHistory={loadHistory}
        onSelectChat={switchChat}
        onDeleteChat={deleteChat}
        onToggleFullscreen={onToggleFullscreen ?? (() => {})}
        isFullscreen={isFullscreen}
        onClose={onClose}
      />

      {/* Always mounted, so the chat keeps its transport, session and transcript. */}
      <AgentPanelColumn fullscreen={isFullscreen}>
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <AgentSpinner size={20} />
          </div>
        ) : active ? (
          <DashboardAgentChat
            key={active.chatId}
            chatId={active.chatId}
            initialMessages={active.messages}
            session={active.session}
            pendingFirstMessage={active.pendingFirstMessage}
            streaming={active.streaming}
            prefill={prefill && prefill.chatId === active.chatId ? prefill : undefined}
            clientData={clientData}
            apiOrigin={apiOrigin}
            actionPath={actionPath}
            projectSlug={project.slug}
            environmentSlug={environment.slug}
            currentPage={currentPage}
            promotedPrompt={promotedPrompt}
            pagePaths={pagePaths}
            // The generated chat name is written before the turn-complete chunk lands.
            onTurnSettled={loadHistory}
            onActivityChange={handleActivityChange}
          />
        ) : (
          <DashboardAgentDraft
            onSubmit={createChat}
            projectSlug={project.slug}
            environmentSlug={environment.slug}
            currentPage={currentPage}
            pageContext={pageContext}
            promotedPrompt={promotedPrompt}
          />
        )}
      </AgentPanelColumn>
    </div>
  );
}
