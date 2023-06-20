import { Fragment } from "react";
import { useIsMac } from "~/hooks/useIsMac";
import { Modifier, ShortcutDefinition } from "~/hooks/useShortcutKeys";
import { cn } from "~/utils/cn";

const variants = {
  small:
    "flex-inline text-[0.55rem] font-medium py-[0.1rem] min-w-[1rem] rounded-[2px] px-[0.2rem] border border-bright/40 text-dimmed group-hover:border-bright/60 group-hover:text-bright transition items-center justify-center text-center uppercase",
  medium:
    "flex-inline text-xxs min-w-[1.2rem] pb-[0.15rem] pt-[0.17rem] px-[0.25rem] rounded-[3px] border border-bright/40 text-dimmed group-hover:border-bright/60 group-hover:text-bright transition items-center justify-center text-center uppercase",
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
  const isMac = useIsMac();
  let relevantShortcut =
    "all" in shortcut ? shortcut.all : isMac ? shortcut.mac : shortcut.windows;
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
      return isMac ? "⌥" : "Alt";
      break;
    case "ctrl":
      return isMac ? "⌃" : "Ctrl";
      break;
    case "meta":
      return isMac ? "⌘" : "Meta";
      break;
    case "shift":
      return isMac ? "⇧" : "Shift";
      break;
  }
}
