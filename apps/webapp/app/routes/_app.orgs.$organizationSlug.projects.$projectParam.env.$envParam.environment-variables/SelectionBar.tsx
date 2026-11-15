import { CheckIcon } from "@heroicons/react/20/solid";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Button, LinkButton, type ButtonVariant } from "~/components/primitives/Buttons";
import { type RenderIcon } from "~/components/primitives/Icon";
import { isTypingIn } from "~/utils/isTypingIn";

export type SelectionAction = {
  label: string;
  icon?: RenderIcon;
  variant: ButtonVariant;
  /** A link instead of a button: navigates rather than acting. */
  to?: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Shown as the button's tooltip while it's disabled. */
  disabledReason?: string;
};

// Opaque, so the sticky actions cell hides what scrolls under it.
const tickedCellClassName =
  "bg-[color-mix(in_srgb,var(--color-indigo-500)_12%,var(--color-background-dimmed))] group-hover/table-row:bg-[color-mix(in_srgb,var(--color-indigo-500)_16%,var(--color-background-dimmed))]";
const tickedOpenCellClassName =
  "bg-[color-mix(in_srgb,var(--color-indigo-500)_16%,var(--color-background-hover))] group-hover/table-row:bg-[color-mix(in_srgb,var(--color-indigo-500)_20%,var(--color-background-hover))]";
const quietCellClassName = "opacity-60 transition-opacity group-hover/table-row:opacity-100";

/**
 * A row cell's look while rows are ticked: ticked rows are tinted with the checkbox's colour (over
 * the open key's grey when both apply); while any are ticked, the others are quieter, except the
 * open key's, which is what the panel shows.
 */
export function tickCellClassName({
  isTicked,
  isAnyTicked,
  isSelected,
}: {
  isTicked: boolean;
  isAnyTicked: boolean;
  isSelected: boolean;
}): string | undefined {
  if (isTicked) {
    return isSelected ? tickedOpenCellClassName : tickedCellClassName;
  }
  return isAnyTicked && !isSelected ? quietCellClassName : undefined;
}

/** True when the focus is on a control the user reached with the keyboard. */
export function hasKeyboardFocus(element: Element | null): element is HTMLElement {
  return element instanceof HTMLElement && element.matches(":focus-visible");
}

/**
 * Shown while anything is ticked: the count, a clear button, then the actions. Escape clears the
 * selection, unless a dialog or a menu is open or the focus is in a field. Floats over the bottom
 * centre of the positioned parent, on a fade of the list.
 */
export function SelectionBar({
  count,
  label,
  onClear,
  restoreFocus,
  actions,
}: {
  count: number;
  /** The visible count, e.g. "4 selected". */
  label: ReactNode;
  onClear: () => void;
  /** Moves the focus into the list when clearing removes the bar from under the keyboard focus. */
  restoreFocus: () => void;
  actions: SelectionAction[];
}) {
  const shouldReduceMotion = useReducedMotion();
  const isShown = count > 0;
  const toolbarRef = useRef<HTMLDivElement>(null);

  // Only for the keyboard: a mouse user's focus falls to the page as before, with no ring.
  const clear = useCallback(() => {
    const focused = document.activeElement;
    const hadKeyboardFocus =
      hasKeyboardFocus(focused) && toolbarRef.current?.contains(focused) === true;
    onClear();
    if (hadKeyboardFocus) {
      restoreFocus();
    }
  }, [onClear, restoreFocus]);

  useEffect(() => {
    if (!isShown) {
      return;
    }
    // Capture on the window runs before the page's own Escape shortcuts (the key panel closes on
    // Escape), so the first press clears the selection and the next one closes the panel.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) {
        return;
      }
      if (isTypingIn(document.activeElement)) {
        return;
      }
      event.stopPropagation();
      clear();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [isShown, clear]);

  return (
    <>
      {/* Always mounted, so screen readers announce the count as it changes. */}
      <span role="status" className="sr-only">
        {isShown ? `${count} selected` : ""}
      </span>
      <AnimatePresence>
        {isShown && (
          <motion.div
            key="selection-bar"
            // The shelf: the list fades out behind the bar, so rows don't run through it.
            className="@container pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center bg-linear-to-t from-background-dimmed via-background-dimmed/90 to-transparent px-4 pb-4 pt-10"
            initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
          >
            <div
              ref={toolbarRef}
              role="toolbar"
              aria-label="Selected values"
              className="pointer-events-auto flex min-h-11 w-fit min-w-[min(35rem,100%)] max-w-full items-center gap-2 rounded border border-grid-bright bg-background-bright pl-3 pr-2 text-sm text-text-bright shadow-lg @max-lg:flex-wrap @max-lg:py-1.5"
            >
              {/* A ticked checkbox, as in the rows: the bar's one accent. */}
              <span
                aria-hidden
                className="grid size-4 flex-none place-items-center rounded-sm bg-indigo-500"
              >
                <CheckIcon className="size-3.5 text-white" />
              </span>
              <span aria-hidden className="min-w-0 truncate font-medium tabular-nums">
                {label}
              </span>
              <span
                aria-hidden
                className="mx-1 h-4 w-px flex-none bg-border-bright @max-lg:hidden"
              />
              <Button
                variant="minimal/small"
                shortcut={{ key: "esc", enabled: false }}
                onClick={clear}
              >
                Clear
              </Button>
              <div className="ml-auto flex items-center gap-1.5 pl-6">
                {actions.map((action) =>
                  action.to ? (
                    <LinkButton
                      key={action.label}
                      to={action.to}
                      variant={action.variant}
                      LeadingIcon={action.icon}
                    >
                      {action.label}
                    </LinkButton>
                  ) : (
                    <Button
                      key={action.label}
                      variant={action.variant}
                      LeadingIcon={action.icon}
                      disabled={action.disabled}
                      tooltip={action.disabled ? action.disabledReason : undefined}
                      onClick={action.onClick}
                    >
                      {action.label}
                    </Button>
                  )
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
