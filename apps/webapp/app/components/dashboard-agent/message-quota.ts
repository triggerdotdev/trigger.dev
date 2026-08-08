// Counted per user across their chats in the org, not per chat, which "New chat"
// would reset.
export const FREE_PLAN_MESSAGE_LIMIT = 20;

export type MessageQuota =
  | { kind: "unlimited" }
  | { kind: "within"; used: number; limit: number; remaining: number }
  | { kind: "reached"; used: number; limit: number };

// Fails open: the cap is a nudge, not a security boundary, so an unknown plan or
// count means no cap.
export function resolveMessageQuota({
  isFreePlan,
  used,
  limit = FREE_PLAN_MESSAGE_LIMIT,
}: {
  isFreePlan: boolean | undefined;
  used: number | undefined;
  limit?: number;
}): MessageQuota {
  if (isFreePlan !== true || used === undefined) return { kind: "unlimited" };
  const remaining = Math.max(0, limit - used);
  return remaining === 0
    ? { kind: "reached", used, limit }
    : { kind: "within", used, limit, remaining };
}

export function countUserMessages(messages: { role: string }[]): number {
  return messages.reduce((total, message) => (message.role === "user" ? total + 1 : total), 0);
}
