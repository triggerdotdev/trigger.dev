import type { Job } from ".prisma/client";
import type { User } from "./user.server";
import { prisma } from "~/db.server";
export type { Job } from ".prisma/client";
export type { JobRunStatus } from ".prisma/client";

export function getJob({
  userId,
  id,
}: Pick<Job, "id"> & {
  userId: User["id"];
}) {
  //just the very basic info because we already fetched it for the Jobs list
  return prisma.job.findFirst({
    select: { id: true, title: true },
    where: { id, organization: { members: { some: { userId } } } },
  });
}
