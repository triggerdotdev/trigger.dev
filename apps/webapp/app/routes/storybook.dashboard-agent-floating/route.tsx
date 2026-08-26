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

/**
 * The dashboard agent's default (and only) mode: a floating window docked at the
 * bottom of the page, draggable across the whole page and resizable by its edges and
 * corners. Static content only — this demos the shell (`FloatingAgentWindow`, the real
 * `DashboardAgentHeader`, and `agentTakeoverClassName` fullscreen), not a live backend.
 */
export default function Story() {
  const [open, setOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);

  // Storybook only: the demo window must not follow you to another story. The real
  // dashboard's chat intentionally persists across navigation — this effect is scoped to
  // this story route and has no equivalent in DashboardAgent.tsx.
  const { pathname } = useLocation();
  const previousPathname = useRef(pathname);
  useEffect(() => {
    if (previousPathname.current === pathname) return;
    previousPathname.current = pathname;
    setOpen(false);
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
      {!open && (
        <div className="px-4">
          <Button variant="primary/medium" onClick={() => setOpen(true)}>
            Open chat
          </Button>
        </div>
      )}
      {open && (
        <FloatingAgentWindow fullscreen={fullscreen}>
          {(dragHandleProps) => (
            <div className="flex h-full flex-col bg-background-bright">
              <motion.div {...dragHandleProps}>
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
                  onClose={() => setOpen(false)}
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
