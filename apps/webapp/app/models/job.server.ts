import type { Job } from ".prisma/client";
import type { User } from "./user.server";
import { prisma } from "~/db.server";
export type { Job } from ".prisma/client";

export function getJob({
  userId,
  id,
}: Pick<Job, "id"> & {
  userId: User["id"];
}) {
  return prisma.job.findFirst({
    where: { id, organization: { members: { some: { userId } } } },
  });
}
