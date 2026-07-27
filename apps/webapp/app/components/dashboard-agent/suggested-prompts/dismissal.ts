/**
 * Per-user chip dismissals.
 *
 * localStorage, not a cookie or a DB row: the panel is client-only, a dismissal
 * is a preference rather than data, and a browser profile is already the unit of
 * "this user". One key per chip id (rather than one key holding a list) so two
 * tabs dismissing different chips can't clobber each other's write.
 */
const KEY_PREFIX = "tdev:dashboard-agent:prompt-dismissed:";

export const dismissedPromptStorageKey = (promptId: string) => `${KEY_PREFIX}${promptId}`;

/** Every chip id this browser has dismissed. Empty when storage is unavailable. */
export function readDismissedPromptIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const ids: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(KEY_PREFIX)) ids.push(key.slice(KEY_PREFIX.length));
    }
    return ids;
  } catch {
    return [];
  }
}

export function writeDismissedPromptId(promptId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(dismissedPromptStorageKey(promptId), "1");
  } catch {
    /* storage full or blocked — the dismissal just doesn't persist */
  }
}
