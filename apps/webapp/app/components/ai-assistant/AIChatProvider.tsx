import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useParams, useLocation } from "@remix-run/react";
import type { UIMessage } from "ai";

interface PageContext {
  userId: string;
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  currentPage: string;
  currentParams: Record<string, string>;
}

interface ChatHistoryEntry {
  id: string;
  title: string;
  updatedAt: string;
}

interface SessionState {
  publicAccessToken: string;
  lastEventId: string | null;
}

interface AIChatContextValue {
  isOpen: boolean;
  toggle: () => void;
  open: (initialQuery?: string) => void;
  close: () => void;
  currentChatId: string;
  startNewChat: () => void;
  switchChat: (chatId: string) => void;
  chatHistory: ChatHistoryEntry[];
  refreshHistory: () => void;
  currentChatMessages: UIMessage[] | undefined;
  sessionState: SessionState | undefined;
  pageContext: PageContext;
  pendingQuery: string | undefined;
  clearPendingQuery: () => void;
}

const AIChatContext = createContext<AIChatContextValue | null>(null);

export function useAIChat() {
  const ctx = useContext(AIChatContext);
  if (!ctx) {
    throw new Error("useAIChat must be used within an AIChatProvider");
  }
  return ctx;
}

/**
 * Like useAIChat, but returns null instead of throwing when there is no
 * provider. The provider is only mounted inside the project layout, so
 * components rendered on account/org-settings pages (e.g. the global NavBar
 * AskAI button) use this to no-op when the assistant isn't available.
 */
export function useOptionalAIChat() {
  return useContext(AIChatContext);
}

function generateChatId() {
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function usePageContext(userId: string): PageContext {
  const params = useParams();
  const location = useLocation();
  const segments = location.pathname.split("/").filter(Boolean);
  const currentPage = segments[segments.length - 1] ?? "overview";

  return {
    userId,
    organizationSlug: params.organizationSlug ?? "",
    projectSlug: params.projectParam ?? "",
    environmentSlug: params.envParam ?? "",
    currentPage,
    currentParams: params as Record<string, string>,
  };
}

export function AIChatProvider({
  userId,
  children,
}: {
  userId: string;
  children: ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [currentChatId, setCurrentChatId] = useState(() => generateChatId());
  const [chatHistory, setChatHistory] = useState<ChatHistoryEntry[]>([]);
  const [currentChatMessages, setCurrentChatMessages] = useState<UIMessage[] | undefined>();
  const [sessionState, setSessionState] = useState<SessionState | undefined>();
  const [pendingQuery, setPendingQuery] = useState<string | undefined>();

  const pageContext = usePageContext(userId);

  const refreshHistory = useCallback(async () => {
    try {
      const res = await fetch("/resources/ai-assistant/history");
      if (res.ok) {
        const data = (await res.json()) as { chats?: ChatHistoryEntry[] };
        setChatHistory(data.chats ?? []);
      }
    } catch {
      // Silently fail — history is non-critical
    }
  }, []);

  const open = useCallback(
    (initialQuery?: string) => {
      if (initialQuery) {
        setPendingQuery(initialQuery);
      }
      setIsOpen(true);
    },
    []
  );

  const close = useCallback(() => {
    setIsOpen(false);
    setPendingQuery(undefined);
  }, []);

  const toggle = useCallback(() => {
    setIsOpen((prev) => {
      if (prev) {
        setPendingQuery(undefined);
      }
      return !prev;
    });
  }, []);

  const startNewChat = useCallback(() => {
    setCurrentChatId(generateChatId());
    setCurrentChatMessages(undefined);
    setSessionState(undefined);
    setPendingQuery(undefined);
  }, []);

  const switchChat = useCallback(
    async (chatId: string) => {
      setCurrentChatId(chatId);
      setPendingQuery(undefined);
      try {
        const res = await fetch(`/resources/ai-assistant/chat/${chatId}`);
        if (res.ok) {
          const data = (await res.json()) as {
            chat?: { title?: string; messages?: UIMessage[] };
            session?: SessionState;
          };
          setCurrentChatMessages(data.chat?.messages ?? []);
          setSessionState(data.session ?? undefined);
          if (data.chat?.title) {
            setChatHistory((prev) =>
              prev.map((c) => (c.id === chatId ? { ...c, title: data.chat!.title! } : c))
            );
          }
        }
      } catch {
        setCurrentChatMessages(undefined);
        setSessionState(undefined);
      }
    },
    []
  );

  const clearPendingQuery = useCallback(() => {
    setPendingQuery(undefined);
  }, []);

  // Load history when panel opens
  useEffect(() => {
    if (isOpen) {
      refreshHistory();
    }
  }, [isOpen, refreshHistory]);

  return (
    <AIChatContext.Provider
      value={{
        isOpen,
        toggle,
        open,
        close,
        currentChatId,
        startNewChat,
        switchChat,
        chatHistory,
        refreshHistory,
        currentChatMessages,
        sessionState,
        pageContext,
        pendingQuery,
        clearPendingQuery,
      }}
    >
      {children}
    </AIChatContext.Provider>
  );
}