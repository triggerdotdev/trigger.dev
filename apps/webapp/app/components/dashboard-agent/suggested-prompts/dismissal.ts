// One key per chip id, not one key holding a list, so two tabs dismissing
// different chips can't clobber each other's write.
const KEY_PREFIX = "tdev:dashboard-agent:prompt-dismissed:";

const dismissedPromptStorageKey = (promptId: string) => `${KEY_PREFIX}${promptId}`;

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

function writeDismissedPromptId(promptId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(dismissedPromptStorageKey(promptId), "1");
  } catch {
    /* storage full or blocked — the dismissal just doesn't persist */
  }
}
