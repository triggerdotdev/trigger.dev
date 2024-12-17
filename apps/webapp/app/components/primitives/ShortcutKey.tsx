import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
} from "@heroicons/react/20/solid";
import { Modifier, ShortcutDefinition } from "~/hooks/useShortcutKeys";
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

type ShortcutKeyProps = {
  shortcut: ShortcutDefinition;
  variant: ShortcutKeyVariant;
  className?: string;
};

export function ShortcutKey({ shortcut, variant, className }: ShortcutKeyProps) {
  const { platform } = useOperatingSystem();
  const isMac = platform === "mac";
  let relevantShortcut = "mac" in shortcut ? (isMac ? shortcut.mac : shortcut.windows) : shortcut;
  const modifiers = relevantShortcut.modifiers ?? [];
  const character = keyString(relevantShortcut.key, isMac, variant);

  return (
    <span className={cn(variants[variant], className)}>
      {modifiers.map((k) => (
        <span key={k}>{modifierString(k, isMac)}</span>
      ))}
      <span>{character}</span>
    </span>
  );
}

function keyString(key: String, isMac: boolean, variant: "small" | "medium" | "medium/bright") {
  key = key.toLowerCase();

  const className = variant === "small" ? "w-2.5 h-4" : "w-3 h-5";

  switch (key) {
    case "enter":
      return isMac ? "↵" : key;
    case "arrowdown":
      return <ChevronDownIcon className={className} />;
    case "arrowup":
      return <ChevronUpIcon className={className} />;
    case "arrowleft":
      return <ChevronLeftIcon className={className} />;
    case "arrowright":
      return <ChevronRightIcon className={className} />;
    default:
      return key;
  }
}

function modifierString(modifier: Modifier, isMac: boolean) {
  switch (modifier) {
    case "alt":
      return isMac ? "⌥" : "Alt+";
    case "ctrl":
      return isMac ? "⌃" : "Ctrl+";
    case "meta":
      return isMac ? "⌘" : "⊞+";
    case "shift":
      return isMac ? "⇧" : "Shift+";
    case "mod":
      return isMac ? "⌘" : "Ctrl+";
  }
}
