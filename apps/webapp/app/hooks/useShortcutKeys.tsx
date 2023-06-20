import { useEffect, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useOperatingSystem } from "~/components/primitives/OperatingSystemProvider";

export type Modifier = "alt" | "ctrl" | "meta" | "shift";

export type Shortcut = {
  key: string;
  modifiers?: Modifier[];
};

export type ShortcutDefinition =
  | {
      windows: Shortcut;
      mac: Shortcut;
    }
  | Shortcut;

type useShortcutKeysProps = {
  shortcut: ShortcutDefinition;
  action: (event: KeyboardEvent) => void;
  disabled?: boolean;
};

export function useShortcutKeys({
  shortcut,
  action,
  disabled = false,
}: useShortcutKeysProps) {
  const keys = createKeysFromShortcut(shortcut);
  useHotkeys(keys, action, { enabled: !disabled });
}

function createKeysFromShortcut(shortcut: ShortcutDefinition) {
  const { platform } = useOperatingSystem();
  const isMac = platform === "mac";
  let relevantShortcut =
    "mac" in shortcut ? (isMac ? shortcut.mac : shortcut.windows) : shortcut;
  const modifiers = relevantShortcut.modifiers;
  const character = relevantShortcut.key;

  return modifiers ? modifiers.map((k) => k).join("+") + "+" : "" + character;
}
