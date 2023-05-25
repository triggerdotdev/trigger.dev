import { prisma } from "~/db.server";

type JobListOptions = {
  userId: string;
  projectSlug: string;
  environmentId: string;
};

export async function jobList({ userId, projectSlug }: JobListOptions) {
  const jobs = await prisma.job.findMany({
    select: {
      id: true,
      slug: true,
      title: true,
      projectId: true,
      aliases: {
        select: {
          version: {
            select: {
              version: true,
              eventSpecification: true,
              runs: {
                select: {
                  createdAt: true,
                  status: true,
                },
                take: 1,
                orderBy: [{ createdAt: "desc" }],
              },
              integrations: {
                select: {
                  metadata: true,
                },
              },
            },
          },
          environment: {
            select: {
              orgMember: {
                select: {
                  userId: true,
                },
              },
            },
          },
        },
        where: {
          name: "latest",
        },
      },
    },
    where: {
      organization: { members: { some: { userId } } },
      project: { slug: projectSlug },
      internal: false,
    },
    orderBy: [{ title: "asc" }],
  });

  return jobs;
}
