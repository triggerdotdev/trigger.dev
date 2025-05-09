import { PrismaClient } from "@trigger.dev/database";

export async function seedCloud(prisma: PrismaClient) {
  if (!process.env.SEED_CLOUD_EMAIL) {
    return;
  }

  const name = process.env.SEED_CLOUD_EMAIL.split("@")[0];

  // Create a user, organization, and project
  const user = await prisma.user.upsert({
    where: {
      email: process.env.SEED_CLOUD_EMAIL,
    },
    create: {
      email: process.env.SEED_CLOUD_EMAIL,
      name,
      authenticationMethod: "MAGIC_LINK",
    },
    update: {},
  });

  const organization = await prisma.organization.upsert({
    where: {
      slug: "seed-org-123",
    },
    create: {
      title: "Personal Workspace",
      slug: "seed-org-123",
      members: {
        create: {
          userId: user.id,
          role: "ADMIN",
        },
      },
      projects: {
        create: {
          name: "My Project",
          slug: "my-project-123",
          externalRef: "my-project-123",
        },
      },
    },
    update: {},
    include: {
      members: true,
      projects: true,
    },
  });

  const adminMember = organization.members[0];
  const defaultProject = organization.projects[0];

  const devEnv = await prisma.runtimeEnvironment.upsert({
    where: {
      apiKey: "tr_dev_bNaLxayOXqoj",
    },
    create: {
      apiKey: "tr_dev_bNaLxayOXqoj",
      pkApiKey: "pk_dev_323f3650218e370508cf",
      slug: "dev",
      type: "DEVELOPMENT",
      project: {
        connect: {
          id: defaultProject.id,
        },
      },
      organization: {
        connect: {
          id: organization.id,
        },
      },
      orgMember: {
        connect: {
          id: adminMember.id,
        },
      },
      shortcode: "octopus-tentacles",
    },
    update: {},
  });

  await prisma.runtimeEnvironment.upsert({
    where: {
      apiKey: "tr_prod_bNaLxayOXqoj",
    },
    create: {
      apiKey: "tr_prod_bNaLxayOXqoj",
      pkApiKey: "pk_dev_323f3650218e378191cf",
      slug: "prod",
      type: "PRODUCTION",
      project: {
        connect: {
          id: defaultProject.id,
        },
      },
      organization: {
        connect: {
          id: organization.id,
        },
      },
      shortcode: "stripey-zebra",
    },
    update: {},
  });
}
