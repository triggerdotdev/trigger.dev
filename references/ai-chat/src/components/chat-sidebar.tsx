"use client";

type ChatMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

type ChatSidebarProps = {
  chats: ChatMeta[];
  activeChatId: string | null;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  onDeleteChat: (id: string) => void;
  onWipeAll: () => void;
  idleTimeoutInSeconds: number;
  onIdleTimeoutChange: (seconds: number) => void;
  taskMode: string;
  onTaskModeChange: (mode: string) => void;
  useHandover: boolean;
  onUseHandoverChange: (on: boolean) => void;
};

export function ChatSidebar({
  chats,
  activeChatId,
  onSelectChat,
  onNewChat,
  onDeleteChat,
  onWipeAll,
  idleTimeoutInSeconds,
  onIdleTimeoutChange,
  taskMode,
  onTaskModeChange,
  useHandover,
  onUseHandoverChange,
}: ChatSidebarProps) {
  const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="flex h-full w-64 shrink-0 flex-col border-r border-gray-200 bg-gray-50">
      <div className="p-3">
        <button
          type="button"
          onClick={onNewChat}
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
        >
          + New Chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 && (
          <p className="px-3 py-8 text-center text-xs text-gray-400">No conversations yet</p>
        )}

        {sorted.map((chat) => (
          <button
            key={chat.id}
            type="button"
            onClick={() => onSelectChat(chat.id)}
            className={`group flex w-full items-start gap-2 px-3 py-2.5 text-left text-sm hover:bg-gray-100 ${
              activeChatId === chat.id ? "bg-white" : ""
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-gray-800">{chat.title}</div>
              <div className="text-[10px] text-gray-400">{timeAgo(chat.updatedAt)}</div>
            </div>
            <span
              onClick={(e) => {
                e.stopPropagation();
                onDeleteChat(chat.id);
              }}
              className="mt-0.5 hidden shrink-0 rounded p-0.5 text-xs text-gray-400 hover:bg-red-100 hover:text-red-600 group-hover:inline-block"
            >
              &times;
            </span>
          </button>
        ))}
      </div>

      <div className="shrink-0 border-t border-gray-200 px-3 py-2.5 space-y-2">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className="shrink-0">Idle timeout</span>
          <input
            type="number"
            min={0}
            step={5}
            value={idleTimeoutInSeconds}
            onChange={(e) => onIdleTimeoutChange(Number(e.target.value))}
            className="w-16 rounded border border-gray-300 px-1.5 py-0.5 text-xs text-gray-600 outline-none focus:border-blue-500"
          />
          <span>s</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className="shrink-0">Task</span>
          <select
            value={taskMode}
            onChange={(e) => onTaskModeChange(e.target.value)}
            className="flex-1 rounded border border-gray-300 px-1.5 py-0.5 text-xs text-gray-600 outline-none focus:border-blue-500"
          >
            <option value="ai-chat">ai-chat (chat.agent)</option>
            <option value="ai-chat-hydrated">ai-chat-hydrated (hydrated)</option>
            <option value="ai-chat-raw">ai-chat-raw (raw task)</option>
            <option value="ai-chat-session">ai-chat-session (session)</option>
            <option value="upgrade-test">upgrade-test (requestUpgrade after 3 turns)</option>
          </select>
        </div>
        <label
          className="flex items-center gap-2 text-xs text-gray-500"
          title="Route first-turn messages through /api/chat (chat.handover) so step 1 streams from the Next.js process while the agent run boots in parallel."
        >
          <input
            type="checkbox"
            checked={useHandover}
            onChange={(e) => onUseHandoverChange(e.target.checked)}
            className="h-3 w-3 rounded border-gray-300"
          />
          <span>Use handover (1st turn)</span>
        </label>
        <button
          type="button"
          onClick={onWipeAll}
          className="w-full rounded border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
        >
          Wipe all chats
        </button>
      </div>
    </div>
  );
}
