import { sql } from "drizzle-orm";
import type { DashboardAgentDb } from "./client.js";

// Shared by `queries.ts` and `watch-queries.ts`. Not part of the package's surface.

export type DashboardAgentTx = Parameters<Parameters<DashboardAgentDb["transaction"]>[0]>[0];

export type DashboardAgentDbOrTx = DashboardAgentDb | DashboardAgentTx;

/** Advisory-lock namespace (ASCII `watc`), so keys can't collide with another lock. */
const WATCH_CHAT_LOCK_NAMESPACE = 0x77617463;

/**
 * Serializes creating a watch against deleting the chat under it. The lock releases with the
 * enclosing transaction, so a plain `Db` handle would drop it immediately — hence tx only.
 */
export function lockChatForWatches(tx: DashboardAgentTx, chatId: string) {
  return tx.execute(
    sql`select pg_advisory_xact_lock(${WATCH_CHAT_LOCK_NAMESPACE}, hashtext(${chatId}))`
  );
}
