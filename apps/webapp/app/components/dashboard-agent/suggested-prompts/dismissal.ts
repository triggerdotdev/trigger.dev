// One key per chip id, not one key holding a list, so two tabs dismissing
// different chips can't clobber each other's write.
const KEY_PREFIX = "tdev:dashboard-agent:prompt-dismissed:";

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
