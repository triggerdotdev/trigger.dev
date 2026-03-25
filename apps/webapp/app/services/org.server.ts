import { prisma } from "~/db.server";
import { requireUserId } from "./session.server";

export async function requireOrganization(request: Request, organizationSlug: string) {
  const userId = await requireUserId(request);
  
  const organization = await prisma.organization.findFirst({
    where: {
      slug: organizationSlug,
      members: { some: { userId } },
      deletedAt: null,
    },
  });

  if (!organization) {
    throw new Response("Organization not found", { status: 404 });
  }

  return { organization, userId };
}
