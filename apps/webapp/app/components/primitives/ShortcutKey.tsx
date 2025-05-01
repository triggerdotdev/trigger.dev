import { KeyboardDownIcon } from "~/assets/icons/KeyboardDownIcon";
import { KeyboardLeftIcon } from "~/assets/icons/KeyboardLeftIcon";
import { KeyboardRightIcon } from "~/assets/icons/KeyboardRightIcon";
import { KeyboardUpIcon } from "~/assets/icons/KeyboardUpIcon";
import { KeyboardWindowsIcon } from "~/assets/icons/KeyboardWindowsIcon";
import { type Modifier, type Shortcut } from "~/hooks/useShortcutKeys";
import { cn } from "~/utils/cn";
import { useOperatingSystem } from "./OperatingSystemProvider";
import { KeyboardEnterIcon } from "~/assets/icons/KeyboardEnterIcon";

const medium =
  "text-[0.75rem] font-medium min-w-[17px] rounded-[2px] tabular-nums px-1 ml-1 -mr-0.5 flex items-center gap-x-1.5 border border-dimmed/40 text-text-dimmed group-hover:text-text-bright/80 group-hover:border-dimmed/60 transition uppercase";

export const variants = {
  small:
    "text-[0.6rem] font-medium min-w-[17px] rounded-[2px] tabular-nums px-1 ml-1 -mr-0.5 flex items-center gap-x-1 border border-dimmed/40 text-text-dimmed group-hover:text-text-bright/80 group-hover:border-dimmed/60 transition uppercase",
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
          <span>{modifierString(k, isMac, variant)}</span>
        </span>
      ))}
      {character && <span>{character}</span>}
    </span>
  );
}

function keyString(key: string, isMac: boolean, variant: "small" | "medium" | "medium/bright") {
  key = key.toLowerCase();

  const className = variant === "small" ? "w-2.5 h-4" : "w-3 h-5";

  switch (key) {
    case "enter":
      return isMac ? (
        <KeyboardEnterIcon className={className} />
      ) : (
        <span className="capitalize">Enter</span>
      );
    case "esc":
      return <span className="capitalize">Esc</span>;
    case "del":
      return <span className="capitalize">Del</span>;
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

function modifierString(
  modifier: Modifier,
  isMac: boolean,
  variant: "small" | "medium" | "medium/bright"
): string | JSX.Element {
  const className = variant === "small" ? "w-2.5 h-4" : "w-3.5 h-5";

  switch (modifier) {
    case "alt":
      return isMac ? "⌥" : <span className="capitalize">Alt</span>;
    case "ctrl":
      return isMac ? "⌃" : <span className="capitalize">Ctrl</span>;
    case "meta":
      return isMac ? "⌘" : <KeyboardWindowsIcon className={className} />;
    case "shift":
      return "⇧";
    case "mod":
      return isMac ? "⌘" : <span className="capitalize">Ctrl</span>;
  }
}
