import type { UIMessage } from "@ai-sdk/react";
import { useLocation } from "@remix-run/react";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "~/components/primitives/Spinner";
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
import { DashboardAgentHeader } from "./DashboardAgentHeader";
import {
  DashboardAgentHistory,
  type DashboardAgentChat as DashboardAgentChatListItem,
} from "./DashboardAgentHistory";

// Restore the last open chat across panel re-opens and page reloads. Scoped by
// org because chats are org-scoped. localStorage (not a cookie) since the panel
// only mounts client-side — the server never needs this.
const lastChatStorageKey = (organizationId: string) =>
  `tdev:dashboard-agent:last-chat:${organizationId}`;

type ActiveChat = {
  chatId: string;
  messages: UIMessage[];
  session: DashboardAgentSession | null;
};

/**
 * The dashboard agent side panel. Owns history, the active chat, and last-chat
 * persistence; resolves a chat's stored transcript + session before mounting
 * the inner `DashboardAgentChat` (keyed by chatId) so resume flows in through
 * the transport's declarative `sessions` option.
 */
export function DashboardAgentPanel({ onClose }: { onClose: () => void }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const user = useUser();
  const apiOrigin = useApiOrigin();
  const location = useLocation();

  const [view, setView] = useState<"chat" | "history">("chat");
  const [chats, setChats] = useState<DashboardAgentChatListItem[]>([]);
  const [active, setActive] = useState<ActiveChat | null>(null);
  const [loading, setLoading] = useState(false);

  const actionPath = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/dashboard-agent`;
  const storageKey = lastChatStorageKey(organization.id);

  const currentPage = location.pathname.split("/").filter(Boolean).pop() ?? "overview";

  const clientData = useMemo<DashboardAgentClientData>(
    () => ({
      userId: user.id,
      organizationId: organization.id,
      projectId: project.id,
      environmentId: environment.id,
      currentPage: location.pathname,
    }),
    [user.id, organization.id, project.id, environment.id, location.pathname]
  );

  const loadHistory = useCallback(async () => {
    const res = await fetch(actionPath);
    if (res.ok) {
      const data = (await res.json()) as { chats?: DashboardAgentChatListItem[] };
      setChats(data.chats ?? []);
    }
  }, [actionPath]);

  // Open a chat by id. A new chat mounts immediately with an empty transcript;
  // an existing one is fetched first so its session hydrates the transport at
  // mount. A stored id that's gone (deleted / never sent) falls back to fresh.
  const openChat = useCallback(
    async (id: string, opts?: { fetchExisting?: boolean }) => {
      setView("chat");
      if (!opts?.fetchExisting) {
        setActive({ chatId: id, messages: [], session: null });
        return;
      }
      setLoading(true);
      try {
        const res = await fetch(`${actionPath}?chatId=${encodeURIComponent(id)}`);
        const data = res.ok
          ? ((await res.json()) as {
              messages?: UIMessage[];
              session?: { publicAccessToken: string; lastEventId: string | null } | null;
            })
          : { messages: [], session: null };
        if (data.messages && data.messages.length > 0) {
          setActive({
            chatId: id,
            messages: data.messages,
            session: data.session?.publicAccessToken
              ? {
                  publicAccessToken: data.session.publicAccessToken,
                  lastEventId: data.session.lastEventId ?? undefined,
                }
              : null,
          });
        } else {
          setActive({ chatId: generateFriendlyId("chat"), messages: [], session: null });
        }
      } finally {
        setLoading(false);
      }
    },
    [actionPath]
  );

  // On open, restore the last chat (or start a new one). Runs once per mount.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(storageKey);
    } catch {
      /* localStorage unavailable — start fresh */
    }
    if (stored) void openChat(stored, { fetchExisting: true });
    else void openChat(generateFriendlyId("chat"));
  }, [openChat, storageKey]);

  // Persist the active chat as the one to restore next time.
  useEffect(() => {
    if (!active?.chatId) return;
    try {
      window.localStorage.setItem(storageKey, active.chatId);
    } catch {
      /* ignore */
    }
  }, [active?.chatId, storageKey]);

  const newChat = useCallback(() => {
    void openChat(generateFriendlyId("chat"));
  }, [openChat]);

  const switchChat = useCallback(
    (id: string) => {
      void openChat(id, { fetchExisting: true });
    },
    [openChat]
  );

  const deleteChat = useCallback(
    async (id: string) => {
      const body = new FormData();
      body.set("intent", "delete");
      body.set("chatId", id);
      await fetch(actionPath, { method: "POST", body });
      if (id === active?.chatId) newChat();
      void loadHistory();
    },
    [actionPath, active?.chatId, newChat, loadHistory]
  );

  const toggleHistory = useCallback(() => {
    setView((v) => {
      if (v === "chat") void loadHistory();
      return v === "chat" ? "history" : "chat";
    });
  }, [loadHistory]);

  return (
    <div className="flex h-full w-[380px] shrink-0 flex-col border-l border-grid-bright bg-background-bright animate-in slide-in-from-right-2 duration-150">
      <DashboardAgentHeader
        view={view}
        onNewChat={newChat}
        onToggleHistory={toggleHistory}
        onClose={onClose}
      />

      {view === "history" ? (
        <DashboardAgentHistory
          chats={chats}
          currentChatId={active?.chatId ?? ""}
          onSelect={switchChat}
          onNewChat={newChat}
          onDelete={deleteChat}
        />
      ) : loading || !active ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-5" />
        </div>
      ) : (
        <DashboardAgentChat
          key={active.chatId}
          chatId={active.chatId}
          initialMessages={active.messages}
          session={active.session}
          clientData={clientData}
          apiOrigin={apiOrigin}
          actionPath={actionPath}
          projectSlug={project.slug}
          environmentSlug={environment.slug}
          currentPage={currentPage}
          onTurnSettled={loadHistory}
        />
      )}
    </div>
  );
}
