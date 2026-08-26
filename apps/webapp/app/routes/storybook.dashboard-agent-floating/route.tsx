import { useLocation } from "@remix-run/react";
import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { ComponentNames } from "../storybook/StoryKit";
import { ChatText, ChatTranscript, ChatTurn } from "~/components/dashboard-agent/chat-layout";
import { DashboardAgentHeader } from "~/components/dashboard-agent/DashboardAgentHeader";
import type { DashboardAgentChat } from "~/components/dashboard-agent/DashboardAgentHistory";
import { FloatingAgentWindow } from "~/components/dashboard-agent/panel-layout";
import { Button } from "~/components/primitives/Buttons";
import { Header1 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";

const NO_CHATS: DashboardAgentChat[] = [];

/** Static content only: this demos the shell (drag, resize, fullscreen), not a live backend. */
export default function Story() {
  const [open, setOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const closeWindow = () => {
    setOpen(false);
    setFullscreen(false);
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
          names={["DashboardAgent.tsx", "panel-layout.tsx", "DraggableResizable.tsx"]}
        />
      </div>
      <div className="flex max-w-3xl flex-col gap-1">
        <Header1>Dashboard agent — floating window</Header1>
        <Paragraph variant="small">
          Drag the header anywhere on the page, resize from any edge or corner. Expand takes over
          the page the same way the old side panel did.
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
        <FloatingAgentWindow fullscreen={fullscreen}>
          {({ dragHandleProps, dragHandleClassName }) => (
            <div className="flex h-full flex-col bg-background-bright">
              <motion.div {...dragHandleProps} className={dragHandleClassName}>
                <DashboardAgentHeader
                  title="New chat"
                  chats={NO_CHATS}
                  currentChatId=""
                  thinkingChatId={null}
                  onNewChat={() => {}}
                  showNewChat={false}
                  onOpenHistory={() => {}}
                  onSelectChat={() => {}}
                  onDeleteChat={() => {}}
                  onToggleFullscreen={() => setFullscreen((f) => !f)}
                  isFullscreen={fullscreen}
                  onClose={closeWindow}
                />
              </motion.div>
              <ChatTranscript>
                <ChatTurn speaker="user">
                  <ChatText speaker="user" text="Why did the queue back up around 2pm?" />
                </ChatTurn>
                <ChatTurn>
                  <ChatText text="Concurrency on the `emails` queue hit its limit at 14:02 and stayed there for about 12 minutes. I can show you the runs that queued behind it." />
                </ChatTurn>
              </ChatTranscript>
            </div>
          )}
        </FloatingAgentWindow>
      )}
    </div>
  );
}
