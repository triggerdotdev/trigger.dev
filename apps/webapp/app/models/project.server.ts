import type { Project } from ".prisma/client";
import type { User } from "./user.server";
import { prisma } from "~/db.server";
export type { Project } from ".prisma/client";

export function getProjectFromSlug({
  userId,
  id,
}: Pick<Project, "id"> & {
  userId: User["id"];
}) {
  return prisma.project.findFirst({
    include: {
      jobs: {
        orderBy: [{ title: "asc" }],
      },
      environments: true,
    },
    where: { id, organization: { members: { some: { userId } } } },
  });
}
