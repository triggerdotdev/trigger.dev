import { prisma } from "~/db.server";
export type { Job, JobRunStatus } from ".prisma/client";

export function findJobByParams({
  userId,
  slug,
  projectSlug,
  organizationSlug,
}: {
  userId: string;
  slug: string;
  projectSlug: string;
  organizationSlug: string;
}) {
  //just the very basic info because we already fetched it for the Jobs list
  return prisma.job.findFirst({
    select: { id: true, title: true },
    where: {
      slug,
      project: { slug: projectSlug },
      organization: { slug: organizationSlug, members: { some: { userId } } },
    },
  });
}
