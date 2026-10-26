import { useHotkeys } from "react-hotkeys-hook";
import { Paragraph } from "~/components/primitives/Paragraph";
import { ShortcutKey, variants } from "~/components/primitives/ShortcutKey";
import { type Shortcut, useShortcutKeys } from "~/hooks/useShortcutKeys";
import { cn } from "~/utils/cn";

export type TreeShortcutOptions = {
  /** Off while the tree isn't the active view. */
  enabled?: boolean;
  onExpandAll?: () => void;
  onCollapseAll?: () => void;
  onToggleLevel?: (level: number) => void;
};

export function KeyboardShortcuts({
  enabled,
  onExpandAll,
  onCollapseAll,
  onToggleLevel,
  afterNavigation,
  trailing,
}: Required<Omit<TreeShortcutOptions, "enabled">> & {
  enabled: boolean;
  afterNavigation?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <>
      <ArrowKeyShortcuts />
      {afterNavigation}
      <ShortcutWithAction
        shortcut={{ key: "e" }}
        action={onExpandAll}
        title="Expand all"
        disabled={!enabled}
      />
      <ShortcutWithAction
        shortcut={{ key: "w" }}
        action={onCollapseAll}
        title="Collapse all"
        disabled={!enabled}
      />
      <NumberShortcuts toggleLevel={onToggleLevel} enabled={enabled} />
      {trailing}
    </>
  );
}

export function AdjacentRunsShortcuts() {
  return (
    <div className="flex items-center gap-0.5">
      <ShortcutKey shortcut={{ key: "[" }} variant="medium" className="ml-0 mr-0 px-1" />
      <ShortcutKey shortcut={{ key: "]" }} variant="medium" className="ml-0 mr-0 px-1" />
      <Paragraph variant="extra-small" className="ml-1.5 whitespace-nowrap">
        Next/previous run
      </Paragraph>
    </div>
  );
}

function ArrowKeyShortcuts() {
  return (
    <div className="flex items-center gap-0.5">
      <ShortcutKey shortcut={{ key: "arrowup" }} variant="medium" className="ml-0 mr-0" />
      <ShortcutKey shortcut={{ key: "arrowdown" }} variant="medium" className="ml-0 mr-0" />
      <ShortcutKey shortcut={{ key: "arrowleft" }} variant="medium" className="ml-0 mr-0" />
      <ShortcutKey shortcut={{ key: "arrowright" }} variant="medium" className="ml-0 mr-0" />
      <Paragraph variant="extra-small" className="ml-1.5 whitespace-nowrap">
        Navigate
      </Paragraph>
    </div>
  );
}

export function ShortcutWithAction({
  shortcut,
  title,
  action,
  disabled,
}: {
  shortcut: Shortcut;
  title: string;
  action: () => void;
  disabled?: boolean;
}) {
  useShortcutKeys({
    shortcut,
    action,
    disabled,
  });

  return (
    <div className="flex items-center gap-0.5">
      <ShortcutKey shortcut={shortcut} variant="medium" className="ml-0 mr-0" />
      <Paragraph variant="extra-small" className="ml-1.5 whitespace-nowrap">
        {title}
      </Paragraph>
    </div>
  );
}

function NumberShortcuts({
  toggleLevel,
  enabled,
}: {
  toggleLevel: (depth: number) => void;
  enabled: boolean;
}) {
  useHotkeys(
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    (event) => {
      toggleLevel(Number(event.key));
    },
    { enabled }
  );

  return (
    <div className="flex items-center gap-0.5">
      <span className={cn(variants.medium, "ml-0 mr-0")}>0</span>
      <span className="text-[0.65rem] text-text-dimmed">–</span>
      <span className={cn(variants.medium, "ml-0 mr-0")}>9</span>
      <Paragraph variant="extra-small" className="ml-1.5 whitespace-nowrap">
        Toggle level
      </Paragraph>
    </div>
  );
}
