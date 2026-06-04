import { PlusIcon, ClockIcon } from "@heroicons/react/20/solid";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { Button } from "~/components/primitives/Buttons";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/Popover";
import { cn } from "~/utils/cn";
import { useAIChat } from "./AIChatProvider";

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

const SCROLL_END_THRESHOLD_PX = 4;

type ScrollFadeEdge = "top" | "bottom";

const SCROLL_FADE_HEIGHT = "h-8";

const scrollFadeBlurLayers: Record<ScrollFadeEdge, { blur: string; mask: string }[]> = {
  bottom: [
    {
      blur: "backdrop-blur-[2px]",
      mask: "linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.12) 50%, transparent 100%)",
    },
    {
      blur: "backdrop-blur-[6px]",
      mask: "linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.2) 45%, transparent 100%)",
    },
    {
      blur: "backdrop-blur-[14px]",
      mask: "linear-gradient(to top, black 0%, rgba(0,0,0,0.35) 40%, transparent 100%)",
    },
  ],
  top: [
    {
      blur: "backdrop-blur-[2px]",
      mask: "linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.12) 50%, transparent 100%)",
    },
    {
      blur: "backdrop-blur-[6px]",
      mask: "linear-gradient(to bottom, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.2) 45%, transparent 100%)",
    },
    {
      blur: "backdrop-blur-[14px]",
      mask: "linear-gradient(to bottom, black 0%, rgba(0,0,0,0.35) 40%, transparent 100%)",
    },
  ],
};

function historyListLabel(chat: { title: string | null; updatedAt: string }) {
  if (chat.title && chat.title !== "New chat") return chat.title;
  return formatRelativeTime(chat.updatedAt);
}

function ScrollEdgeGradientBlur({ edge, visible }: { edge: ScrollFadeEdge; visible: boolean }) {
  const tintMask =
    edge === "bottom"
      ? "linear-gradient(to top, black 0%, transparent 72%)"
      : "linear-gradient(to bottom, black 0%, transparent 72%)";

  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0 z-10 transition-opacity duration-300",
        SCROLL_FADE_HEIGHT,
        edge === "bottom" ? "bottom-0" : "top-0",
        visible ? "opacity-100" : "opacity-0"
      )}
    >
      {scrollFadeBlurLayers[edge].map((layer) => (
        <div
          key={layer.blur}
          className={cn("absolute inset-0", layer.blur)}
          style={{ WebkitMaskImage: layer.mask, maskImage: layer.mask }}
        />
      ))}
      <div
        className={cn(
          "absolute inset-0",
          edge === "bottom"
            ? "bg-gradient-to-t from-background-bright/35 via-background-bright/8 to-transparent"
            : "bg-gradient-to-b from-background-bright/35 via-background-bright/8 to-transparent"
        )}
        style={{ WebkitMaskImage: tintMask, maskImage: tintMask }}
      />
    </div>
  );
}

function measureScrollFades(el: HTMLDivElement) {
  const canScroll = el.scrollHeight > el.clientHeight + 1;
  const atTop = el.scrollTop <= SCROLL_END_THRESHOLD_PX;
  const atBottom =
    el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_END_THRESHOLD_PX;
  return {
    showTop: canScroll && !atTop,
    showBottom: canScroll && !atBottom,
  };
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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollFades, setScrollFades] = useState({ showTop: false, showBottom: false });

  const updateScrollFades = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      setScrollFades({ showTop: false, showBottom: false });
      return;
    }
    setScrollFades(measureScrollFades(el));
  }, []);

  const setScrollContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node;
      if (node) {
        setScrollFades(measureScrollFades(node));
      }
    },
    []
  );

  useLayoutEffect(() => {
    if (!isOpen) {
      setScrollFades({ showTop: false, showBottom: false });
      return;
    }

    updateScrollFades();
    const el = scrollRef.current;
    if (!el) return;

    const observer = new ResizeObserver(updateScrollFades);
    observer.observe(el);

    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(updateScrollFades);
    });

    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [isOpen, chats, updateScrollFades]);

  return (
    <div className="relative">
      <ScrollEdgeGradientBlur edge="top" visible={scrollFades.showTop} />
      <div
        ref={setScrollContainerRef}
        onScroll={updateScrollFades}
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
      <ScrollEdgeGradientBlur edge="bottom" visible={scrollFades.showBottom} />
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
