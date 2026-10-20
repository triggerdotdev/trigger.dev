import { useLocation } from "@remix-run/react";
import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { ComponentNames } from "../storybook/StoryKit";
import { ChatText, ChatTranscript, ChatTurn } from "~/components/dashboard-agent/chat-layout";
import { DashboardAgentHeader } from "~/components/dashboard-agent/DashboardAgentHeader";
import type { DashboardAgentChat } from "~/components/dashboard-agent/DashboardAgentHistory";
import {
  AGENT_PANEL_DEFAULT_WIDTH,
  FloatingAgentWindow,
  type DashboardAgentMode,
} from "~/components/dashboard-agent/panel-layout";
import { Button } from "~/components/primitives/Buttons";
import { Header1 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** One chat for each state a history row shows: current, unread, ages from now to weeks, long. */
function exampleChats(now: number): DashboardAgentChat[] {
  const at = (ago: number) => new Date(now - ago).toISOString();
  return [
    { id: "chat_queue", title: "Why did the queue back up around 2pm?", lastMessageAt: at(20_000) },
    {
      id: "chat_receipts",
      title: "send-order-receipt keeps hitting 429s",
      lastMessageAt: at(25 * MINUTE),
      hasUnreadWork: true,
    },
    { id: "chat_backfill", title: "Watch the nightly backfill", lastMessageAt: at(3 * HOUR) },
    { id: "chat_deploy", title: "Why did deploy 20261016.4 fail?", lastMessageAt: at(DAY) },
    { id: "chat_concurrency", title: "How do concurrency keys work?", lastMessageAt: at(3 * DAY) },
    {
      id: "chat_retries",
      title: "Retry settings for the email tasks",
      lastMessageAt: at(9 * DAY),
    },
    {
      id: "chat_compute",
      title: "Compare generate-monthly-report durations before and after the 4.7 upgrade",
      lastMessageAt: at(5 * 7 * DAY),
    },
  ];
}

const REPLIES: Record<string, string> = {
  chat_queue:
    "Concurrency on the `emails` queue hit its limit at 14:02 and stayed there for about 12 minutes. I can show you the runs that queued behind it.",
  chat_receipts:
    "Every failure is a 429 from the email provider, and they cluster when more than about 200 receipts go out at once.",
  chat_backfill: "I'm watching the nightly backfill and will tell you here when it finishes.",
  chat_deploy:
    "The build step timed out installing dependencies. I'm checking whether the lockfile changed.",
};

/** Static content only: this demos the shell (drag, resize, fullscreen), not a live backend. */
export default function Story() {
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState<DashboardAgentMode>("floating");
  const [chats, setChats] = useState(() => exampleChats(Date.now()));
  const [currentChatId, setCurrentChatId] = useState("chat_queue");
  const currentChat = chats.find((chat) => chat.id === currentChatId);
  const closeWindow = () => {
    setOpen(false);
    setMode("floating");
  };

  // SSR has no window, so the initial rect (and hydrated one) would mismatch; render the
  // demo only once mounted client-side.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- SSR has no window; flips once client-mounted.
    setMounted(true);
  }, []);

  // Storybook only: closes the demo on route change. The real chat intentionally persists.
  const { pathname } = useLocation();
  const previousPathname = useRef(pathname);
  useEffect(() => {
    if (previousPathname.current === pathname) return;
    previousPathname.current = pathname;
    closeWindow();
  }, [pathname]);

  return (
    <div className="relative flex h-screen flex-col gap-4 p-6">
      <div className="px-4 pt-4">
        <ComponentNames
          names={[
            "DashboardAgent.tsx",
            "DashboardAgentHeader.tsx",
            "DashboardAgentHistory.tsx",
            "panel-layout.tsx",
            "DraggableResizable.tsx",
          ]}
        />
      </div>
      <div className="flex max-w-3xl flex-col gap-1">
        <Header1>Dashboard agent — floating panel</Header1>
        <Paragraph variant="small">
          Drag the header anywhere on the page and resize from any edge or corner, or let go at the
          right edge or the top to switch to Right panel or Full page; the layout menu switches
          back. The chat title opens the history, with a chat in each state a row can show; picking
          one switches to it, and deleting one removes it.
        </Paragraph>
      </div>
      {mounted && !open && (
        <div className="px-4">
          <Button variant="primary/medium" onClick={() => setOpen(true)}>
            Open chat
          </Button>
        </div>
      )}
      {mounted && open && (
        // Stands in for the dashboard's split layout: pinned to the right edge at the docked
        // width in Right panel, and no box at all otherwise. Only its class changes between
        // modes, so the window inside never remounts.
        <div
          className={
            mode === "rightPanel"
              ? "fixed inset-y-0 right-0 z-40 border-l border-grid-bright"
              : "contents"
          }
          style={mode === "rightPanel" ? { width: AGENT_PANEL_DEFAULT_WIDTH } : undefined}
        >
          <FloatingAgentWindow mode={mode} onRequestModeChange={setMode}>
            {({ dragHandleProps, dragHandleClassName }) => (
              <div className="flex h-full flex-col bg-background-bright">
                <motion.div {...dragHandleProps} className={dragHandleClassName}>
                  <DashboardAgentHeader
                    title={currentChat?.title ?? "New chat"}
                    chats={chats}
                    currentChatId={currentChatId}
                    onOpenHistory={() => {}}
                    onSelectChat={setCurrentChatId}
                    onDeleteChat={(chatId) => {
                      setChats((current) => current.filter((chat) => chat.id !== chatId));
                      if (chatId === currentChatId) setCurrentChatId("");
                    }}
                    mode={mode}
                    onModeChange={setMode}
                    onClose={closeWindow}
                  />
                </motion.div>
                <ChatTranscript>
                  {currentChat ? (
                    <>
                      <ChatTurn speaker="user">
                        <ChatText speaker="user" text={currentChat.title} />
                      </ChatTurn>
                      <ChatTurn>
                        <ChatText
                          text={REPLIES[currentChat.id] ?? "Here's what I found in this project."}
                        />
                      </ChatTurn>
                    </>
                  ) : null}
                </ChatTranscript>
              </div>
            )}
          </FloatingAgentWindow>
        </div>
      )}
    </div>
  );
}
