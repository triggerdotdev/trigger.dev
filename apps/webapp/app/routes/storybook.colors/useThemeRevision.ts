import { useEffect, useState, useSyncExternalStore } from "react";

/** `<html>` attributes that can change what a colour token resolves to. */
const WATCHED_ATTRIBUTES = ["data-theme", "data-icon-contrast", "style"];

/**
 * Read too early and a transitioning foreground pairs with an already-snapped
 * background. Clear of both the 150ms default and the 300ms call sites.
 */
const TRANSITION_SETTLE_MS = 500;

/* One observer for the page, not one per swatch. */
const listeners = new Set<() => void>();
let revision = 0;
let observer: MutationObserver | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

function bump() {
  revision += 1;
  for (const listener of listeners) listener();
}

/** Read now, then again once the transitions land. */
function bumpAndSettle() {
  bump();
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(bump, TRANSITION_SETTLE_MS);
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  if (!observer) {
    observer = new MutationObserver(bumpAndSettle);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: WATCHED_ATTRIBUTES,
    });
    // In dev the stylesheet can land after hydration.
    requestAnimationFrame(bumpAndSettle);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
    }
  };
}

/** Ticks whenever the resolved palette could have moved. */
export function useThemeRevision() {
  return useSyncExternalStore(
    subscribe,
    () => revision,
    () => 0
  );
}

/**
 * The theme on `<html>`. Returned as a value, not inherited: the chart-2/3
 * override needs `data-theme` and `data-icon-contrast` on the same element.
 */
export function useDocumentTheme() {
  const revision = useThemeRevision();
  const [theme, setTheme] = useState<string | undefined>(undefined);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
    setTheme(document.documentElement.getAttribute("data-theme") ?? undefined);
  }, [revision]);

  return theme;
}

export function useDocumentIconContrast() {
  const revision = useThemeRevision();
  const [isOn, setIsOn] = useState(false);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
    setIsOn(document.documentElement.getAttribute("data-icon-contrast") === "true");
  }, [revision]);

  return isOn;
}
