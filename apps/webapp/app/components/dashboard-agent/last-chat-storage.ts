export const lastChatStorageKey = (organizationId: string) =>
  `tdev:dashboard-agent:last-chat:${organizationId}`;

export function readLastChat(storageKey: string): { chatId: string; path: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    // Pre-path entries were the bare chat id: no page to match, so start fresh.
    if (!raw.startsWith("{")) return null;
    const parsed = JSON.parse(raw) as { chatId?: string; path?: string };
    return parsed.chatId && parsed.path ? { chatId: parsed.chatId, path: parsed.path } : null;
  } catch {
    return null;
  }
}

export function writeLastChat(storageKey: string, entry: { chatId: string; path: string }) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(entry));
  } catch {
    /* ignore */
  }
}

export function forgetLastChat(storageKey: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    /* ignore */
  }
}

/**
 * The chat's own org, never the panel's: an org switch re-keys the storage entry in the same
 * effect flush that still holds the previous org's chat, which would file it under the new key.
 */
export function shouldPersistLastChat<T extends { chatId: string; organizationId: string }>(
  active: T | null | undefined,
  organizationId: string
): active is T {
  return Boolean(active?.chatId) && active?.organizationId === organizationId;
}
