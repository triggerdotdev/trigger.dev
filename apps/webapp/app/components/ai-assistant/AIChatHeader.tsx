import { PlusIcon, ClockIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { Button } from "~/components/primitives/Buttons";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/Popover";
import { cn } from "~/utils/cn";
import { useAIChat } from "./AIChatProvider";
import { ScrollEdgeFade, useScrollFades } from "./ScrollFade";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;

  if (diff < MINUTE) return "Just now";
  if (diff < HOUR) {
    const mins = Math.floor(diff / MINUTE);
    return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  }
  if (diff < DAY) {
    const hours = Math.floor(diff / HOUR);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  if (diff < 2 * DAY) return "Yesterday";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function historyListLabel(chat: { title: string | null; updatedAt: string }) {
  if (chat.title && chat.title !== "New chat") return chat.title;
  return formatRelativeTime(chat.updatedAt);
}

function ChatHistoryList({
  chats,
  currentChatId,
  isOpen,
  onSelect,
}: {
  chats: { id: string; title: string | null; updatedAt: string }[];
  currentChatId: string;
  isOpen: boolean;
  onSelect: (chatId: string) => void;
}) {
  const { ref, onScroll, fades } = useScrollFades({
    axis: "vertical",
    enabled: isOpen,
    deps: [chats],
  });

  return (
    <div className="relative">
      <ScrollEdgeFade edge="top" visible={fades.start} />
      <div
        ref={ref}
        onScroll={onScroll}
        className="max-h-[360px] overflow-y-auto py-1 pb-3 pt-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
      >
        {chats.map((chat) => {
          const isActive = chat.id === currentChatId;
          const hasTitle = chat.title && chat.title !== "New chat";
          return (
            <button
              key={chat.id}
              onClick={() => onSelect(chat.id)}
              className={cn(
                "flex w-full flex-col gap-0.5 py-2 text-left transition-colors hover:bg-charcoal-700/50",
                isActive ? "border-l-2 border-indigo-500 pl-2.5 pr-3" : "px-3"
              )}
            >
              <span className="truncate text-sm text-text-bright">{historyListLabel(chat)}</span>
              {hasTitle ? (
                <span className="text-xs text-text-dimmed">{formatRelativeTime(chat.updatedAt)}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      <ScrollEdgeFade edge="bottom" visible={fades.end} />
    </div>
  );
}

export function AIChatHeader() {
  const { close, startNewChat, chatHistory, switchChat, currentChatId } = useAIChat();
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <div className="flex h-11 items-center justify-between border-b border-grid-bright px-3">
      <div className="flex items-center gap-1.5">
        <span className="inline-flex motion-safe:hover:animate-ai-sparkle-hover motion-reduce:hover:animate-none">
          <AISparkleIcon className="size-4" />
        </span>
        <span className="text-sm font-medium text-text-bright">AI Assistant</span>
      </div>
      <div className="flex items-center gap-1">
        <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
          <PopoverTrigger asChild>
            <button
              className="flex size-7 items-center justify-center rounded text-text-dimmed transition-colors hover:bg-charcoal-700 hover:text-text-bright"
              title="Chat history"
            >
              <ClockIcon className="size-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            side="bottom"
            sideOffset={4}
            collisionPadding={12}
            className="w-[min(22.125rem,calc(100vw-1.5rem))] min-w-0 overflow-hidden p-0"
            style={{ maxHeight: "min(400px, var(--radix-popover-content-available-height))" }}
          >
            <div className="border-b border-grid-bright px-3 py-2 text-xs font-medium uppercase tracking-wider text-text-dimmed">
              Chat History
            </div>
            {chatHistory.length === 0 ? (
              <div className="py-4" />
            ) : (
              <ChatHistoryList
                chats={chatHistory}
                currentChatId={currentChatId}
                isOpen={historyOpen}
                onSelect={(chatId) => {
                  switchChat(chatId);
                  setHistoryOpen(false);
                }}
              />
            )}
          </PopoverContent>
        </Popover>

        <button
          onClick={startNewChat}
          className="flex size-7 items-center justify-center rounded text-text-dimmed transition-colors hover:bg-charcoal-700 hover:text-text-bright"
          title="New chat"
        >
          <PlusIcon className="size-4" />
        </button>

        <Button
          onClick={close}
          variant="minimal/small"
          TrailingIcon={ExitIcon}
          shortcut={{ key: "esc" }}
          shortcutPosition="before-trailing-icon"
          className="pl-1"
        />
      </div>
    </div>
  );
}
