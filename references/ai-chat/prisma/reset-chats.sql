-- Wipe customer-side chat state for a fresh smoke-test slate.
-- Run via `pnpm run db:reset:chats`.
-- Leaves User rows intact (they're upserted by onPreload/onChatStart),
-- but clears every Chat + ChatSession so a chatId from one target
-- (test cloud / local) can't carry stale session/PAT/lastEventId state
-- into the other.
TRUNCATE "Chat", "ChatSession";
