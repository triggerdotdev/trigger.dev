import type { Job } from ".prisma/client";
import type { User } from "./user.server";
import { prisma } from "~/db.server";
export type { Job } from ".prisma/client";
export type { JobRunStatus } from ".prisma/client";

export function getJob({
  userId,
  slug,
}: Pick<Job, "slug"> & {
  userId: User["id"];
}) {
  //just the very basic info because we already fetched it for the Jobs list
  return prisma.job.findFirst({
    select: { id: true, title: true },
    where: { slug, organization: { members: { some: { userId } } } },
  });
}
