import { useHotkeys } from "react-hotkeys-hook";
import { useOperatingSystem } from "~/components/primitives/OperatingSystemProvider";
import { useShortcuts } from "~/components/primitives/ShortcutsProvider";

export type Modifier = "alt" | "ctrl" | "meta" | "shift" | "mod";

export type Shortcut = {
  key: string;
  modifiers?: Modifier[];
  enabledOnInputElements?: boolean;
  enabled?: boolean;
  /** Set when the browser binds the same keystroke to something of its own. */
  preventDefault?: boolean;
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
    (event) => {
      if (!event.repeat) {
        action(event);
      }
    },
    hotkeyOptions({ shortcut: relevantShortcut, isEnabled, enabledOnInputElements })
  );
}

export type HotkeyOptions = {
  enabled: boolean;
  enableOnFormTags: boolean;
  enableOnContentEditable: boolean;
  preventDefault: boolean;
};

// react-hotkeys-hook runs `preventDefault` before it checks `enabled`, so a
// disabled shortcut must not ask for it.
export function hotkeyOptions({
  shortcut,
  isEnabled,
  enabledOnInputElements,
}: {
  shortcut: Shortcut | undefined;
  isEnabled: boolean;
  enabledOnInputElements?: boolean;
}): HotkeyOptions {
  const onInputElements = enabledOnInputElements ?? shortcut?.enabledOnInputElements ?? false;

  return {
    enabled: isEnabled,
    enableOnFormTags: isEnabled && onInputElements,
    enableOnContentEditable: isEnabled && onInputElements,
    preventDefault: isEnabled && (shortcut?.preventDefault ?? false),
  };
}

function createKeysFromShortcut(shortcut: Shortcut | undefined) {
  if (!shortcut) {
    return [];
  }

  const modifiers = shortcut.modifiers;
  const character = shortcut.key;

  return modifiers ? modifiers.map((k) => k).join("+") + "+" + character : character;
}
