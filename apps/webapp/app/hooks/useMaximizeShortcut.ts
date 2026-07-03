import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";

/**
 * Shared "v" shortcut for chart/widget cards that can go fullscreen: toggles the
 * maximized state, but only for the card the cursor is currently over (or, when
 * already maximized, closes it regardless). Used by both ChartCard and QueryWidget
 * so the hover-scoped behaviour stays in one place.
 */
export function useMaximizeShortcut({
  containerRef,
  isMaximized,
  setIsMaximized,
  disabled,
}: {
  containerRef: RefObject<HTMLElement>;
  isMaximized: boolean;
  setIsMaximized: Dispatch<SetStateAction<boolean>>;
  disabled?: boolean;
}) {
  useShortcutKeys({
    shortcut: { key: "v" },
    action: useCallback(() => {
      const isHovered = containerRef.current?.matches(":hover");
      if (!isMaximized && !isHovered) return;
      setIsMaximized((prev) => !prev);
    }, [isMaximized, containerRef, setIsMaximized]),
    disabled,
  });
}
