import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { ChatFloatingPanel } from "~/assets/icons/ChatFloatingPanel";
import { ChatFullScreen } from "~/assets/icons/ChatFullScreen";
import { ChatRightPanel } from "~/assets/icons/ChatRightPanel";
import { CrossIcon } from "~/assets/icons/CrossIcon";
import { Button } from "~/components/primitives/Buttons";
import { Popover, PopoverArrowTrigger, PopoverContent } from "~/components/primitives/Popover";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import type { Shortcut } from "~/hooks/useShortcutKeys";
import {
  DashboardAgentDeleteChatDialog,
  DashboardAgentHistoryMenu,
  type DashboardAgentChat,
} from "./DashboardAgentHistory";
import { chatHistoryTriggerLabel } from "./header-labels";
import type { DashboardAgentMode } from "./panel-layout";

const MODE_OPTIONS: { mode: DashboardAgentMode; label: string; Icon: typeof ChatFloatingPanel }[] =
  [
    { mode: "floating", label: "Floating", Icon: ChatFloatingPanel },
    { mode: "rightPanel", label: "Right panel", Icon: ChatRightPanel },
    { mode: "fullscreen", label: "Fullscreen", Icon: ChatFullScreen },
  ];

// Display only. The key is registered once, in `DashboardAgent`; registering it
// anywhere else makes the keystroke fire twice.
export const NEW_CHAT_SHORTCUT: Shortcut = {
  modifiers: ["mod"],
  key: "j",
  enabledOnInputElements: true,
};

export function ModeToggle({
  mode,
  onModeChange,
}: {
  mode: DashboardAgentMode;
  onModeChange: (mode: DashboardAgentMode) => void;
}) {
  const [isExpanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef(new Map<DashboardAgentMode, HTMLButtonElement>());
  const currentOption = MODE_OPTIONS.find((option) => option.mode === mode) ?? MODE_OPTIONS[0];
  const otherOptions = MODE_OPTIONS.filter((option) => option.mode !== mode);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- collapses when `mode` changes externally (e.g. route-driven).
    setExpanded(false);
  }, [mode]);

  // Radio semantics only while the options are on screen. Collapsed there is one control
  // and nothing to choose between, so it stays an ordinary disclosure button — a lone
  // `radio` carrying `aria-expanded` is neither.
  useEffect(() => {
    const el = triggerRef.current;
    if (!el) return;
    if (isExpanded) {
      el.removeAttribute("aria-haspopup");
      el.removeAttribute("aria-expanded");
      el.setAttribute("role", "radio");
      el.setAttribute("aria-checked", "true");
    } else {
      el.removeAttribute("role");
      el.removeAttribute("aria-checked");
      el.setAttribute("aria-haspopup", "true");
      el.setAttribute("aria-expanded", "false");
    }
    el.tabIndex = 0;
  }, [isExpanded]);

  // Roving tabindex: the unchecked options are reachable by arrow key, not by Tab.
  useEffect(() => {
    if (!isExpanded) return;
    for (const option of otherOptions) {
      const el = optionRefs.current.get(option.mode);
      if (!el) continue;
      el.setAttribute("role", "radio");
      el.setAttribute("aria-checked", "false");
      el.tabIndex = -1;
    }
  }, [otherOptions, isExpanded]);

  // Arrow keys move the selection, as in any radio group. Listened for on the radios
  // themselves: the group is not a tab stop and must not become click-focusable.
  useEffect(() => {
    if (!isExpanded) return;
    const nodes = [triggerRef.current, ...otherOptions.map((o) => optionRefs.current.get(o.mode))];

    // The row is `flex-row-reverse`, so moving right on screen is moving backwards
    // through `MODE_OPTIONS`.
    const step = (delta: number) => {
      const index = MODE_OPTIONS.findIndex((option) => option.mode === mode);
      const next = MODE_OPTIONS[(index + delta + MODE_OPTIONS.length) % MODE_OPTIONS.length]!;
      onModeChange(next.mode);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        step(-1);
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        step(1);
      }
    };

    for (const node of nodes) node?.addEventListener("keydown", onKeyDown);
    return () => {
      for (const node of nodes) node?.removeEventListener("keydown", onKeyDown);
    };
  }, [isExpanded, otherOptions, mode, onModeChange]);

  useEffect(() => {
    if (!isExpanded) return;

    function handlePointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setExpanded(false);
      }
    }

    // Capture phase + preventDefault: DashboardAgentPanel's own Escape handler
    // (bubble phase) checks defaultPrevented before closing the whole panel.
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setExpanded(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isExpanded]);

  return (
    <div
      ref={containerRef}
      role={isExpanded ? "radiogroup" : undefined}
      aria-label={isExpanded ? "Chat display mode" : undefined}
      className="flex flex-row-reverse items-center"
    >
      <Button
        ref={triggerRef}
        variant="minimal/small"
        className="aspect-square h-6 p-1"
        // Named for the mode it shows: expanded it is the group's checked radio, and
        // collapsed the tooltip says the same thing.
        aria-label={currentOption.label}
        tooltip={currentOption.label}
        onClick={() => setExpanded((open) => !open)}
        LeadingIcon={<currentOption.Icon className="size-4 text-text-dimmed" />}
      />
      <AnimatePresence initial={false}>
        {isExpanded &&
          otherOptions.map(({ mode: option, label, Icon }) => (
            <motion.div
              key={option}
              initial={{ opacity: 0, width: 0, x: 8 }}
              animate={{ opacity: 1, width: "auto", x: 0 }}
              exit={{ opacity: 0, width: 0, x: 8 }}
              transition={{ duration: 0.15 }}
              className="overflow-hidden"
            >
              <Button
                ref={(el) => {
                  if (el) optionRefs.current.set(option, el);
                  else optionRefs.current.delete(option);
                }}
                variant="minimal/small"
                className="aspect-square h-6 p-1"
                aria-label={label}
                tooltip={label}
                onClick={() => {
                  onModeChange(option);
                  setExpanded(false);
                }}
                LeadingIcon={<Icon className="size-4 text-text-dimmed" />}
              />
            </motion.div>
          ))}
      </AnimatePresence>
    </div>
  );
}

export function DashboardAgentHeader({
  title,
  chats,
  currentChatId,
  thinkingChatId,
  onOpenHistory,
  onSelectChat,
  onDeleteChat,
  mode,
  onModeChange,
  onClose,
}: {
  title: string;
  chats: DashboardAgentChat[];
  currentChatId: string;
  thinkingChatId?: string | null;
  onOpenHistory: () => void;
  onSelectChat: (chatId: string) => void;
  onDeleteChat: (chatId: string) => void;
  mode: DashboardAgentMode;
  onModeChange: (mode: DashboardAgentMode) => void;
  onClose: () => void;
}) {
  const [isHistoryOpen, setHistoryOpen] = useState(false);
  const [historyOpenedAt, setHistoryOpenedAt] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DashboardAgentChat | null>(null);

  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-grid-bright pl-1 pr-1.5">
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
          <span className="truncate text-sm font-medium text-text-bright">{title}</span>
        </PopoverArrowTrigger>
        <PopoverContent
          className="w-72 max-w-(--radix-popover-content-available-width) p-0"
          align="start"
        >
          {historyOpenedAt === null ? null : (
            <DashboardAgentHistoryMenu
              chats={chats}
              currentChatId={currentChatId}
              thinkingChatId={thinkingChatId}
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

      <div className="flex shrink-0 items-center gap-0.5" data-agent-no-drag>
        <ModeToggle mode={mode} onModeChange={onModeChange} />
        <Button
          variant="minimal/small"
          className="aspect-square h-6 p-1"
          aria-label="Close (Esc)"
          tooltip={
            <span className="flex items-center">
              Close
              <ShortcutKey shortcut={{ key: "esc" }} variant="medium" />
            </span>
          }
          onClick={onClose}
          LeadingIcon={<CrossIcon className="size-4 text-text-dimmed" />}
        />
      </div>
    </div>
  );
}
