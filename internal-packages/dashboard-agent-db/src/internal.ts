import { sql } from "drizzle-orm";
import type { DashboardAgentDb } from "./client.js";

// Shared by `queries.ts` and `watch-queries.ts`. Not part of the package's surface.

export type DashboardAgentDbOrTx =
  | DashboardAgentDb
  | Parameters<Parameters<DashboardAgentDb["transaction"]>[0]>[0];

/** Advisory-lock namespace (ASCII `watc`), so keys can't collide with another lock. */
const WATCH_CHAT_LOCK_NAMESPACE = 0x77617463;

/** Serializes creating a watch against deleting the chat under it. Transaction-scoped. */
export function lockChatForWatches(tx: DashboardAgentDbOrTx, chatId: string) {
  return tx.execute(
    sql`select pg_advisory_xact_lock(${WATCH_CHAT_LOCK_NAMESPACE}, hashtext(${chatId}))`
  );
}
