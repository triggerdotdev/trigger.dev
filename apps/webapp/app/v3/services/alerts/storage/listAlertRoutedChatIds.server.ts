import { type PrismaClientOrTransaction } from "~/db.server";

export async function listAlertRoutedChatIds(
  db: PrismaClientOrTransaction,
  organizationId: string
): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ chatId: string }>>`
    SELECT DISTINCT notifier->>'chatId' AS "chatId"
    FROM "Alert", jsonb_array_elements("Alert"."notifiers") AS notifier
    WHERE "Alert"."organizationId" = ${organizationId}
      AND notifier->>'type' = 'chat'
      AND notifier->>'chatId' IS NOT NULL
  `;
  return rows.map((row) => row.chatId);
}
