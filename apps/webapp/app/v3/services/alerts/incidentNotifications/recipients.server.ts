import { prisma, type PrismaClientOrTransaction } from "~/db.server";

export const INCIDENT_EMAIL_PAGE_SIZE = 100;

export type IncidentEmailRecipient = {
  userId: string;
  email: string;
};

export type IncidentEmailRecipientsPage = {
  recipients: IncidentEmailRecipient[];
  /** Cursor (last user id) to pass to the next page, or null when done. */
  nextCursor: string | null;
};

/**
 * One page of recipients: distinct users who ADMIN at least one non-deleted org.
 * Transactional, so we don't filter on the marketing-email preference.
 */
export async function getIncidentEmailRecipientsPage(
  cursor: string | null,
  take: number = INCIDENT_EMAIL_PAGE_SIZE,
  db: PrismaClientOrTransaction = prisma
): Promise<IncidentEmailRecipientsPage> {
  const users = await db.user.findMany({
    where: {
      orgMemberships: {
        some: {
          role: "ADMIN",
          organization: { deletedAt: null },
        },
      },
    },
    select: { id: true, email: true },
    orderBy: { id: "asc" },
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = users.length > take;
  const page = hasMore ? users.slice(0, take) : users;

  return {
    recipients: page.map((u) => ({ userId: u.id, email: u.email })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}
