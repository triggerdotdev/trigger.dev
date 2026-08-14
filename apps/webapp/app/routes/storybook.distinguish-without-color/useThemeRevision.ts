import { useEffect, useState, useSyncExternalStore } from "react";

/** Attributes on `<html>` that can change what a color token resolves to:
 *  the theme, the accessibility preference, and the inline `--theme-contrast`
 *  the interface-contrast slider writes into `style`. */
const WATCHED_ATTRIBUTES = ["data-theme", "data-icon-contrast", "style"];

/* One observer for the whole page, not one per swatch - the audit renders a few
   hundred measured rows and each of them wants the same signal. */
const listeners = new Set<() => void>();
let revision = 0;
let observer: MutationObserver | null = null;

function bump() {
  revision += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  if (!observer) {
    observer = new MutationObserver(bump);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: WATCHED_ATTRIBUTES,
    });
    // One tick on the next frame: in dev the stylesheet can land after
    // hydration, and a ratio measured before it does is meaningless.
    requestAnimationFrame(bump);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
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
