import { MagnifyingGlassIcon, TrashIcon } from "@heroicons/react/20/solid";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3/utils/durations";
import { useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { Dialog, DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { AgentSpinner } from "~/components/primitives/Spinner";
import { AgentList, AgentListRow, AgentListRowAction } from "./list-row";

// Date fields arrive as strings over the loader's JSON.
export type DashboardAgentChat = {
  id: string;
  title: string;
  lastMessageAt: string | null;
  hasOpenInvestigation?: boolean;
};

type ChatProcess = "thinking" | "investigating";

const PROCESS_LABELS: Record<ChatProcess, string> = {
  thinking: "Agent is thinking",
  investigating: "Investigation in progress",
};

function chatProcess(chat: DashboardAgentChat, isThinking: boolean): ChatProcess | null {
  if (isThinking) return "thinking";
  if (chat.hasOpenInvestigation) return "investigating";
  return null;
}

function ProcessIcon({ process }: { process: ChatProcess }) {
  const label = PROCESS_LABELS[process];
  // No tooltip trigger here: the row is a button, and this would nest one inside it.
  return (
    <span title={label} aria-label={label} role="img" className="shrink-0 text-text-dimmed">
      {process === "investigating" ? (
        <MagnifyingGlassIcon className="size-3.5" />
      ) : (
        <AgentSpinner size={14} />
      )}
    </span>
  );
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
  thinkingChatId,
  onSelect,
  onDelete,
}: {
  chats: DashboardAgentChat[];
  currentChatId: string;
  thinkingChatId?: string | null;
  onSelect: (chatId: string) => void;
  onDelete: (chatId: string) => void;
}) {
  const [pendingDelete, setPendingDelete] = useState<DashboardAgentChat | null>(null);
  const now = Date.now();

  return (
    <>
      <div className="max-h-80 overflow-y-auto p-1.5 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
        {chats.length === 0 ? (
          <Paragraph variant="small" className="p-1.5 text-text-dimmed">
            No previous chats yet.
          </Paragraph>
        ) : (
          <AgentList>
            {chats.map((chat) => {
              const process = chatProcess(chat, chat.id === thinkingChatId);
              const age = chat.lastMessageAt ? chatAge(chat.lastMessageAt, now) : undefined;
              return (
                <AgentListRow
                  key={chat.id}
                  label={chat.title}
                  status={process ? <ProcessIcon process={process} /> : null}
                  meta={age}
                  variant={chat.id === currentChatId ? "selected" : "default"}
                  onSelect={() => onSelect(chat.id)}
                  action={
                    <AgentListRowAction
                      icon={TrashIcon}
                      label={`Delete chat: ${chat.title}`}
                      onClick={() => setPendingDelete(chat)}
                      danger
                    />
                  }
                />
              );
            })}
          </AgentList>
        )}
      </div>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>Delete this chat?</DialogHeader>
          <div className="flex flex-col gap-3 pt-3">
            <Paragraph>
              "{pendingDelete?.title}" and everything in it will be deleted. This can't be undone.
            </Paragraph>
            <FormButtons
              confirmButton={
                <Button
                  type="button"
                  variant="danger/medium"
                  LeadingIcon={TrashIcon}
                  shortcut={{ modifiers: ["mod"], key: "enter" }}
                  onClick={() => {
                    if (pendingDelete) onDelete(pendingDelete.id);
                    setPendingDelete(null);
                  }}
                >
                  Delete chat
                </Button>
              }
              cancelButton={
                <Button variant="tertiary/medium" onClick={() => setPendingDelete(null)}>
                  Cancel
                </Button>
              }
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
