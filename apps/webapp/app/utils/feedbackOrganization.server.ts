import type { PrismaReplicaClient } from "@trigger.dev/database";
import { organizationSlugFromPath } from "./organizationSlugFromPath";

type OrgReader = Pick<PrismaReplicaClient, "organization">;

// The org a feedback message is about: the org page it was sent from, else the user's only org.
// Membership-scoped, so a forged path can't attribute a thread to someone else's org.
export async function feedbackOrganization(
  userId: string,
  path: string,
  replica: OrgReader,
  primary: OrgReader
): Promise<{ id: string; title: string } | undefined> {
  const slug = organizationSlugFromPath(path);
  const query = (client: OrgReader) =>
    client.organization.findMany({
      where: { members: { some: { userId } }, deletedAt: null, ...(slug ? { slug } : {}) },
      select: { id: true, title: true },
      take: 2,
    });
  // Replica first; a miss may be replication lag on a just-created org, so retry the primary.
  let orgs = await query(replica);
  if (orgs.length === 0) orgs = await query(primary);
  return orgs.length === 1 ? orgs[0] : undefined;
}
