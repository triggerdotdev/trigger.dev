import { useEffect, useRef, useState } from "react";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverMenuItem,
  PopoverTrigger,
} from "~/components/primitives/Popover";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import type { Shortcut } from "~/hooks/useShortcutKeys";
import { CHAT_MODE_OPTIONS } from "./chat-mode-options";
import {
  DashboardAgentDeleteChatDialog,
  DashboardAgentHistoryMenu,
  type DashboardAgentChat,
} from "./DashboardAgentHistory";
import { chatHistoryTriggerLabel } from "./header-labels";
import { DashboardPanelHeader, PANEL_TITLE_CLASS } from "./DashboardPanelChrome";
import type { DashboardAgentMode } from "./panel-layout";

// Display only. The key is registered once, in `DashboardAgent`; registering it
// anywhere else makes the keystroke fire twice.
export const NEW_CHAT_SHORTCUT: Shortcut = {
  modifiers: ["mod"],
  key: "j",
  enabledOnInputElements: true,
};

/** Open state for the layout menu, and what keeps its trigger's tooltip out of the way. The menu
 * closes whenever the layout changes, picked from the menu or not: a route leaving Full page moves
 * the panel out from under an open menu. */
export function useModeMenu(mode: DashboardAgentMode) {
  const [isOpen, setOpen] = useState(false);
  // Closing the menu from inside hands focus back to the trigger, and focus opens its tooltip,
  // which would then linger after every choice with the pointer nowhere near it.
  const skipNextFocusTooltip = useRef(false);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- closes when `mode` changes externally (e.g. route-driven).
    setOpen(false);
  }, [mode]);

  return {
    isOpen,
    setOpen,
    /** For a row picked, or Escape. An outside click keeps focus where it lands, so it doesn't. */
    closeFromInside: () => {
      skipNextFocusTooltip.current = true;
      setOpen(false);
    },
    /** For the trigger, whose own handlers run before the tooltip's: preventing an event stops the
     * tooltip asking to open at all. Holding its `open` shut instead leaves Radix out of step with
     * what's shown, and a tooltip asked for over the open menu then shows once it closes. */
    tooltipGuards: {
      onFocus: (event: React.FocusEvent) => {
        if (!skipNextFocusTooltip.current) return;
        skipNextFocusTooltip.current = false;
        event.preventDefault();
      },
      // Never over the open menu.
      onPointerMove: (event: React.PointerEvent) => {
        if (isOpen) event.preventDefault();
      },
    },
  };
}

/** The menu's rows: every layout, the current one checked. */
export function ModeMenuOptions({
  mode,
  onModeChange,
  onDone,
}: {
  mode: DashboardAgentMode;
  /** Only for a different layout: picking the current one just closes the menu. */
  onModeChange: (mode: DashboardAgentMode) => void;
  onDone: () => void;
}) {
  return (
    <div className="flex flex-col gap-1 p-1">
      {CHAT_MODE_OPTIONS.map(({ mode: option, label, Icon }) => (
        <PopoverMenuItem
          key={option}
          icon={Icon}
          leadingIconClassName="size-4"
          // The check matches the layout icons; at the menu's default size it reads larger.
          trailingIconClassName="size-4"
          title={label}
          isSelected={option === mode}
          onClick={() => {
            onDone();
            if (option !== mode) onModeChange(option);
          }}
        />
      ))}
    </div>
  );
}

/** The layout picker: the current layout's icon, opening a menu of all of them. */
export function ModeMenu({
  mode,
  onModeChange,
}: {
  mode: DashboardAgentMode;
  onModeChange: (mode: DashboardAgentMode) => void;
}) {
  const menu = useModeMenu(mode);
  const current = CHAT_MODE_OPTIONS.find((option) => option.mode === mode) ?? CHAT_MODE_OPTIONS[0];

  return (
    <Popover open={menu.isOpen} onOpenChange={menu.setOpen}>
      <SimpleTooltip
        asChild
        tabbable
        disableHoverableContent
        delayDuration={500}
        content="Change layout"
        button={
          // Styled as the minimal icon buttons beside it. `Button` can't be the trigger: it
          // drops the `aria-expanded` and `aria-haspopup` a popover trigger needs.
          <PopoverTrigger
            {...menu.tooltipGuards}
            aria-label={`Change layout, currently ${current.label}`}
            className="flex size-6 cursor-pointer items-center justify-center rounded-[3px] text-text-dimmed transition focus-custom hover:bg-tertiary aria-expanded:bg-tertiary"
          >
            <current.Icon className="size-4" />
          </PopoverTrigger>
        }
      />
      <PopoverContent
        align="end"
        className="p-0"
        aria-label="Chat layout"
        onEscapeKeyDown={menu.closeFromInside}
      >
        <ModeMenuOptions mode={mode} onModeChange={onModeChange} onDone={menu.closeFromInside} />
      </PopoverContent>
    </Popover>
  );
}

export function DashboardAgentHeader({
  title,
  chats,
  currentChatId,
  onOpenHistory,
  onSelectChat,
  onDeleteChat,
  mode,
  onModeChange,
  onClose,
  actions,
}: {
  title: string;
  chats: DashboardAgentChat[];
  currentChatId: string;
  onOpenHistory: () => void;
  onSelectChat: (chatId: string) => void;
  onDeleteChat: (chatId: string) => void;
  mode: DashboardAgentMode;
  onModeChange: (mode: DashboardAgentMode) => void;
  onClose: () => void;
  /** Additive, contextual action (e.g. DEC-067's "Manual setup"); absent for every other caller. */
  actions?: React.ReactNode;
}) {
  const [isHistoryOpen, setHistoryOpen] = useState(false);
  const [historyOpenedAt, setHistoryOpenedAt] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DashboardAgentChat | null>(null);

  return (
    <DashboardPanelHeader
      title={
        <>
          <Popover
            open={isHistoryOpen}
            onOpenChange={(open) => {
              setHistoryOpen(open);
              if (open) {
                setHistoryOpenedAt(Date.now());
                onOpenHistory();
              }
            }}
          >
            <PopoverArrowTrigger
              variant="minimal"
              isOpen={isHistoryOpen}
              overflowHidden
              className="min-w-0"
              aria-label={chatHistoryTriggerLabel(title)}
              title={title}
            >
              <span className={PANEL_TITLE_CLASS}>{title}</span>
            </PopoverArrowTrigger>
            <PopoverContent
              // `min-w-0` over the popover's own `min-w-max`, which would stretch it to the longest
              // title instead of truncating at this width.
              className="w-72 min-w-0 max-w-(--radix-popover-content-available-width) p-0"
              align="start"
            >
              {historyOpenedAt === null ? null : (
                <DashboardAgentHistoryMenu
                  chats={chats}
                  currentChatId={currentChatId}
                  now={historyOpenedAt}
                  onSelect={(chatId) => {
                    setHistoryOpen(false);
                    onSelectChat(chatId);
                  }}
                  onRequestDelete={(chat) => {
                    setHistoryOpen(false);
                    setPendingDelete(chat);
                  }}
                />
              )}
            </PopoverContent>
          </Popover>

          <DashboardAgentDeleteChatDialog
            chat={pendingDelete}
            onOpenChange={(open) => !open && setPendingDelete(null)}
            onConfirm={onDeleteChat}
          />
        </>
      }
      actions={
        <>
          {actions}
          <ModeMenu mode={mode} onModeChange={onModeChange} />
        </>
      }
      onClose={onClose}
    />
  );
}
