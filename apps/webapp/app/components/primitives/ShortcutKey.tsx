import { Fragment } from "react";
import { Modifier, ShortcutDefinition } from "~/hooks/useShortcutKeys";
import { cn } from "~/utils/cn";
import { useOperatingSystem } from "./OperatingSystemProvider";

const variants = {
  small:
    "text-[0.6rem] font-medium min-w-[17px] rounded-[2px] px-1 ml-1 -mr-0.5 grid place-content-center border border-dimmed/40 text-dimmed group-hover:text-bright/80 group-hover:border-dimmed/60 transition uppercase",
  medium:
    "text-[0.75rem] font-medium min-w-[17px] rounded-[2px] px-1 ml-1 -mr-0.5 grid place-content-center border border-dimmed/40 text-dimmed group-hover:text-bright/80 group-hover:border-dimmed/60 transition uppercase",
};

export type ShortcutKeyVariant = keyof typeof variants;

type ShortcutKeyProps = {
  shortcut: ShortcutDefinition;
  variant: ShortcutKeyVariant;
  className?: string;
};

export function ShortcutKey({
  shortcut,
  variant,
  className,
}: ShortcutKeyProps) {
  const { platform } = useOperatingSystem();
  const isMac = platform === "mac";
  let relevantShortcut =
    "mac" in shortcut ? (isMac ? shortcut.mac : shortcut.windows) : shortcut;
  const modifiers = relevantShortcut.modifiers ?? [];
  const character = relevantShortcut.key;

  return (
    <span className={cn(variants[variant], className)}>
      {modifiers.map((k) => (
        <Fragment key={k}>{modifierString(k, isMac)}</Fragment>
      ))}
      {character}
    </span>
  );
}

function modifierString(modifier: Modifier, isMac: boolean) {
  switch (modifier) {
    case "alt":
      return isMac ? "⌥" : "Alt+";
    case "ctrl":
      return isMac ? "⌃" : "Ctrl+";
    case "meta":
      return isMac ? "⌘" : "⊞";
    case "shift":
      return isMac ? "⇧" : "Shift+";
  }
}
