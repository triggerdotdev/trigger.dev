import { useHotkeys } from "react-hotkeys-hook";
import { useOperatingSystem } from "~/components/primitives/OperatingSystemProvider";
import { useShortcuts } from "~/components/primitives/ShortcutsProvider";

export type Modifier = "alt" | "ctrl" | "meta" | "shift" | "mod";

export type Shortcut = {
  key: string;
  modifiers?: Modifier[];
  enabledOnInputElements?: boolean;
  enabled?: boolean;
};

export type ShortcutDefinition =
  | {
      windows: Shortcut;
      mac: Shortcut;
    }
  | Shortcut;

type useShortcutKeysProps = {
  shortcut: ShortcutDefinition | undefined;
  action: (event: KeyboardEvent) => void;
  disabled?: boolean;
  enabledOnInputElements?: boolean;
};

export function useShortcutKeys({
  shortcut,
  action,
  disabled = false,
  enabledOnInputElements,
}: useShortcutKeysProps) {
  const { platform } = useOperatingSystem();
  const { areShortcutsEnabled } = useShortcuts();
  const isMac = platform === "mac";
  const relevantShortcut =
    shortcut && "mac" in shortcut ? (isMac ? shortcut.mac : shortcut.windows) : shortcut;

  const keys = createKeysFromShortcut(relevantShortcut);

  const isEnabled = !disabled && areShortcutsEnabled && relevantShortcut?.enabled !== false;

  useHotkeys(
    keys,
    (event, hotkeysEvent) => {
      action(event);
    },
    {
      enabled: isEnabled,
      enableOnFormTags:
        isEnabled && (enabledOnInputElements ?? relevantShortcut?.enabledOnInputElements),
      enableOnContentEditable:
        isEnabled && (enabledOnInputElements ?? relevantShortcut?.enabledOnInputElements),
    }
  );
}

function createKeysFromShortcut(shortcut: Shortcut | undefined) {
  if (!shortcut) {
    return [];
  }

  const modifiers = shortcut.modifiers;
  const character = shortcut.key;

  return modifiers ? modifiers.map((k) => k).join("+") + "+" + character : character;
}
