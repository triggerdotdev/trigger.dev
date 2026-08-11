import { type RefObject } from "react";
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
  /**
   * The element this shortcut belongs to. When set, an Escape shortcut is ignored
   * while the element sits behind an open overlay, so one Escape can't close both
   * a dialog and the panel behind it. Other shortcuts are unaffected.
   */
  elementRef?: RefObject<HTMLElement | null>;
};

/** Layered surfaces that own the keyboard while they're open. */
const OVERLAY_ROLES = '[role="dialog"],[role="alertdialog"],[role="listbox"],[role="menu"]';

const ESCAPE_KEYS = ["esc", "escape"];

function isEscapeShortcut(shortcut: Shortcut | undefined) {
  return !!shortcut && ESCAPE_KEYS.includes(shortcut.key.toLowerCase());
}

function isBlockedByOverlay(event: KeyboardEvent, element: HTMLElement | null) {
  // Radix marks everything outside an open modal `aria-hidden`, which covers
  // modals that don't move focus into themselves.
  if (element?.closest('[aria-hidden="true"]')) return true;

  const target = event.target instanceof Element ? event.target : null;
  const overlay = target?.closest(OVERLAY_ROLES);

  return !!overlay && (!element || !overlay.contains(element));
}

export function useShortcutKeys({
  shortcut,
  action,
  disabled = false,
  enabledOnInputElements,
  elementRef,
}: useShortcutKeysProps) {
  const { platform } = useOperatingSystem();
  const { areShortcutsEnabled } = useShortcuts();
  const isMac = platform === "mac";
  const relevantShortcut =
    shortcut && "mac" in shortcut ? (isMac ? shortcut.mac : shortcut.windows) : shortcut;

  const keys = createKeysFromShortcut(relevantShortcut);

  const isEnabled = !disabled && areShortcutsEnabled && relevantShortcut?.enabled !== false;
  const guardAgainstOverlays = isEscapeShortcut(relevantShortcut);

  useHotkeys(
    keys,
    (event) => {
      if (event.repeat) return;
      if (guardAgainstOverlays && elementRef && isBlockedByOverlay(event, elementRef.current)) {
        return;
      }

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
