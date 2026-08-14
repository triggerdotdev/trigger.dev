import { useEffect, useState, useSyncExternalStore } from "react";

/** Attributes on `<html>` that can change what a color token resolves to:
 *  the theme, the accessibility preference, and the inline `--theme-contrast`
 *  the interface-contrast slider writes into `style`. */
const WATCHED_ATTRIBUTES = ["data-theme", "data-icon-contrast", "style"];

/**
 * How long to wait before re-reading. Plenty of components put a CSS
 * `transition` on their text color, and at the moment the attribute changes the
 * transition has not started - the computed color is still the *outgoing* one,
 * while untransitioned backgrounds have already snapped to the new theme. Read
 * then and you pair the old foreground with the new fill, which is how a
 * perfectly fine button came out at 2.75:1. Tailwind's default is 150ms and a
 * few call sites use 300ms, so settle well clear of both.
 */
const TRANSITION_SETTLE_MS = 500;

/* One observer for the whole page, not one per swatch - the audit renders a few
   hundred measured rows and each of them wants the same signal. */
const listeners = new Set<() => void>();
let revision = 0;
let observer: MutationObserver | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

function bump() {
  revision += 1;
  for (const listener of listeners) listener();
}

/** Read now so nothing looks frozen, then again once the transitions land. */
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
    // One tick on the next frame: in dev the stylesheet can land after
    // hydration, and a ratio measured before it does is meaningless.
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

/**
 * A counter that ticks whenever the resolved palette could have moved. Measured
 * ratios re-run off this, so flipping the theme switcher above re-reads every
 * swatch instead of leaving stale numbers on screen.
 */
export function useThemeRevision() {
  return useSyncExternalStore(
    subscribe,
    () => revision,
    () => 0
  );
}

/**
 * Whether the document-wide "Distinguish without color" preference is on. The
 * audit page shows both treatments at once, so it needs to know when the header
 * switch has turned the left-hand column into a duplicate of the right.
 */
export function useDocumentIconContrast() {
  const revision = useThemeRevision();
  const [isOn, setIsOn] = useState(false);

  useEffect(() => {
    setIsOn(document.documentElement.getAttribute("data-icon-contrast") === "true");
  }, [revision]);

  return isOn;
}
