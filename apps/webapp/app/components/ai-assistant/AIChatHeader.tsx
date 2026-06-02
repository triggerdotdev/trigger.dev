import { XMarkIcon, PlusIcon, ClockIcon } from "@heroicons/react/20/solid";
import { useState, useRef, useEffect } from "react";
import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import { useAIChat } from "./AIChatProvider";

export function AIChatHeader() {
  const { close, startNewChat, chatHistory, switchChat } = useAIChat();
  const [showHistory, setShowHistory] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (historyRef.current && !historyRef.current.contains(event.target as Node)) {
        setShowHistory(false);
      }
    }
    if (showHistory) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showHistory]);

  return (
    <div className="flex h-11 items-center justify-between border-b border-grid-bright px-3">
      <div className="flex items-center gap-1.5">
        <AISparkleIcon className="size-5" />
        <span className="text-sm font-medium text-text-bright">AI Assistant</span>
      </div>
      <div className="flex items-center gap-1">
        {/* History */}
        <div className="relative" ref={historyRef}>
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="flex size-7 items-center justify-center rounded text-text-dimmed transition hover:bg-charcoal-700 hover:text-text-bright"
            title="Chat history"
          >
            <ClockIcon className="size-4" />
          </button>
          {showHistory && chatHistory.length > 0 && (
            <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-md border border-grid-bright bg-background-bright shadow-lg">
              <div className="max-h-64 overflow-y-auto py-1 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
                {chatHistory.map((chat) => (
                  <button
                    key={chat.id}
                    onClick={() => {
                      switchChat(chat.id);
                      setShowHistory(false);
                    }}
                    className="w-full px-3 py-2 text-left text-xs text-text-dimmed transition hover:bg-charcoal-750 hover:text-text-bright"
                  >
                    <div className="truncate font-medium">{chat.title}</div>
                    <div className="text-[10px] text-text-dimmed/60">
                      {new Date(chat.updatedAt).toLocaleDateString()}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* New chat */}
        <button
          onClick={startNewChat}
          className="flex size-7 items-center justify-center rounded text-text-dimmed transition hover:bg-charcoal-700 hover:text-text-bright"
          title="New chat"
        >
          <PlusIcon className="size-4" />
        </button>

        {/* Close */}
        <button
          onClick={close}
          className="flex size-7 items-center justify-center rounded text-text-dimmed transition hover:bg-charcoal-700 hover:text-text-bright"
          title="Close"
        >
          <XMarkIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}