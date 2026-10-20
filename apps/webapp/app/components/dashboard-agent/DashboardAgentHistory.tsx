import { TrashIcon } from "@heroicons/react/20/solid";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3/utils/durations";
import { CrossIcon } from "~/assets/icons/CrossIcon";
import { Button } from "~/components/primitives/Buttons";
import { Dialog, DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { AgentList, AgentListRow, AgentListRowAction } from "./list-row";
import type { WatchChip } from "./WatchChips";

// Date fields arrive as strings over the loader's JSON.
export type DashboardAgentChat = {
  id: string;
  title: string;
  lastMessageAt: string | null;
  kind?: "alert_creation" | null;
  watches?: WatchChip[];
  hasUnreadWake?: boolean;
  /** The chat answered, settled a card or woke while it was closed. */
  hasUnreadWork?: boolean;
  hasActiveWatch?: boolean;
  hasOpenInvestigation?: boolean;
};

const ALERT_CREATION_TAG = "New alert";

/** A wake is unread work too, so one predicate answers for both. */
export function chatIsUnread(chat: DashboardAgentChat): boolean {
  return (chat.hasUnreadWake ?? false) || (chat.hasUnreadWork ?? false);
}

// Must stay a stable sort on one key: everything else keeps the server's order.
function unreadFirst(chats: DashboardAgentChat[]): DashboardAgentChat[] {
  return [...chats].sort((a, b) => Number(chatIsUnread(b)) - Number(chatIsUnread(a)));
}

// Weeks are the coarsest unit: months render as "1.8mo" for eight weeks.
const AGE_UNITS = ["w", "d", "h", "m"] as const;

export function chatAge(lastMessageAt: string, now: number = Date.now()): string | undefined {
  const at = Date.parse(lastMessageAt);
  if (Number.isNaN(at)) return undefined;
  const elapsed = Math.max(0, now - at);
  if (elapsed < 60_000) return "now";
  return formatDurationMilliseconds(elapsed, {
    style: "short",
    maxUnits: 1,
    maxDecimalPoints: 0,
    units: [...AGE_UNITS],
  });
}

export function DashboardAgentHistoryMenu({
  chats,
  currentChatId,
  now,
  onSelect,
  onRequestDelete,
}: {
  chats: DashboardAgentChat[];
  currentChatId: string;
  now: number;
  onSelect: (chatId: string) => void;
  onRequestDelete: (chat: DashboardAgentChat) => void;
}) {
  return (
    <div className="max-h-80 overflow-y-auto p-1 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
      {chats.length === 0 ? (
        <Paragraph variant="small" className="p-2 text-text-dimmed">
          No previous chats yet.
        </Paragraph>
      ) : (
        <AgentList>
          {unreadFirst(chats).map((chat) => {
            const age = chat.lastMessageAt ? chatAge(chat.lastMessageAt, now) : undefined;
            return (
              <AgentListRow
                key={chat.id}
                label={
                  chat.kind === "alert_creation" ? (
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="shrink-0 rounded border border-grid-bright px-1 text-xxs text-text-dimmed">
                        {ALERT_CREATION_TAG}
                      </span>
                      {chat.title !== ALERT_CREATION_TAG ? (
                        <span className="truncate">{chat.title}</span>
                      ) : null}
                    </span>
                  ) : (
                    chat.title
                  )
                }
                unread={chatIsUnread(chat)}
                meta={age}
                variant={chat.id === currentChatId ? "selected" : "default"}
                onSelect={() => onSelect(chat.id)}
                action={
                  <AgentListRowAction
                    icon={CrossIcon}
                    label={`Delete chat: ${chat.title}`}
                    tooltip="Delete chat"
                    onClick={() => onRequestDelete(chat)}
                  />
                }
              />
            );
          })}
        </AgentList>
      )}
    </div>
  );
}

// Rendered outside the history popover: inside it, focus moving to the dialog dismisses the
// popover, which unmounts the dialog before it can be answered.
export function DashboardAgentDeleteChatDialog({
  chat,
  onOpenChange,
  onConfirm,
}: {
  chat: DashboardAgentChat | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (chatId: string) => void;
}) {
  return (
    <Dialog open={chat !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>Delete this chat?</DialogHeader>
        <div className="flex flex-col gap-3 pt-3">
          <Paragraph>
            "{chat?.title}" and everything in it will be deleted. This can't be undone.
          </Paragraph>
          <FormButtons
            confirmButton={
              <Button
                type="button"
                variant="danger/medium"
                LeadingIcon={TrashIcon}
                shortcut={{ modifiers: ["mod"], key: "enter" }}
                onClick={() => {
                  if (chat) onConfirm(chat.id);
                  onOpenChange(false);
                }}
              >
                Delete chat
              </Button>
            }
            cancelButton={
              <Button variant="secondary/medium" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
