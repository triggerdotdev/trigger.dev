import { KeyboardDownIcon } from "~/assets/icons/KeyboardDownIcon";
import { KeyboardLeftIcon } from "~/assets/icons/KeyboardLeftIcon";
import { KeyboardRightIcon } from "~/assets/icons/KeyboardRightIcon";
import { KeyboardUpIcon } from "~/assets/icons/KeyboardUpIcon";
import { KeyboardWindowsIcon } from "~/assets/icons/KeyboardWindowsIcon";
import { Modifier, Shortcut } from "~/hooks/useShortcutKeys";
import { cn } from "~/utils/cn";
import { useOperatingSystem } from "./OperatingSystemProvider";

const medium =
  "text-[0.75rem] font-medium min-w-[17px] rounded-[2px] px-1 ml-1 -mr-0.5 flex items-center gap-x-1.5 border border-dimmed/40 text-text-dimmed group-hover:text-text-bright/80 group-hover:border-dimmed/60 transition uppercase";

export const variants = {
  small:
    "text-[0.6rem] font-medium min-w-[17px] rounded-[2px] px-1 ml-1 -mr-0.5 flex items-center gap-x-1 border border-dimmed/40 text-text-dimmed group-hover:text-text-bright/80 group-hover:border-dimmed/60 transition uppercase",
  medium,
  "medium/bright": cn(medium, "bg-charcoal-750 text-text-bright border-charcoal-650"),
};

export type ShortcutKeyVariant = keyof typeof variants;

type ShortcutKey = Partial<Shortcut>;

type ShortcutKeyDefinition =
  | {
      windows: ShortcutKey;
      mac: ShortcutKey;
    }
  | ShortcutKey;

type ShortcutKeyProps = {
  shortcut: ShortcutKeyDefinition;
  variant: ShortcutKeyVariant;
  className?: string;
};

export function ShortcutKey({ shortcut, variant, className }: ShortcutKeyProps) {
  const { platform } = useOperatingSystem();
  const isMac = platform === "mac";
  let relevantShortcut = "mac" in shortcut ? (isMac ? shortcut.mac : shortcut.windows) : shortcut;
  const modifiers = relevantShortcut.modifiers ?? [];
  const character = relevantShortcut.key ? keyString(relevantShortcut.key, isMac, variant) : null;

  return (
    <span className={cn(variants[variant], className)}>
      {modifiers.map((k) => (
        <span key={k}>
          <span>{modifierString(k, isMac)}</span>
        </span>
      ))}
      {character && <span>{character}</span>}
    </span>
  );
}

function keyString(key: String, isMac: boolean, variant: "small" | "medium" | "medium/bright") {
  key = key.toLowerCase();

  const className = variant === "small" ? "w-2.5 h-4" : "w-3 h-5";

  switch (key) {
    case "enter":
      return isMac ? "↵" : key;
    case "esc":
      return <span className="capitalize">Esc</span>;
    case "arrowdown":
      return <KeyboardDownIcon className={className} />;
    case "arrowup":
      return <KeyboardUpIcon className={className} />;
    case "arrowleft":
      return <KeyboardLeftIcon className={className} />;
    case "arrowright":
      return <KeyboardRightIcon className={className} />;
    default:
      return key;
  }
}

function modifierString(modifier: Modifier, isMac: boolean): string | JSX.Element {
  switch (modifier) {
    case "alt":
      return isMac ? "⌥" : "Alt+";
    case "ctrl":
      return isMac ? "⌃" : "Ctrl+";
    case "meta":
      return isMac ? "⌘" : <KeyboardWindowsIcon />;
    case "shift":
      return isMac ? "⇧" : "Shift+";
    case "mod":
      return isMac ? "⌘" : "Ctrl+";
  }
}
