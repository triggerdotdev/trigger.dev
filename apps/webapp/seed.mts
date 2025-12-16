import { prisma } from "./app/db.server";
import { createOrganization } from "./app/models/organization.server";
import { createProject } from "./app/models/project.server";
import { AuthenticationMethod, Organization, Prisma, User } from "@trigger.dev/database";

async function seed() {
  console.log("🌱 Starting seed...");

  // Create or find the local user
  let user = await prisma.user.findUnique({
    where: { email: "local@trigger.dev" },
  });

  if (!user) {
    console.log("Creating local user...");
    user = await prisma.user.create({
      data: {
        email: "local@trigger.dev",
        authenticationMethod: AuthenticationMethod.MAGIC_LINK,
        name: "Local Developer",
        displayName: "Local Developer",
        admin: true,
        confirmedBasicDetails: true,
      },
    });
    console.log(`✅ Created user: ${user.email} (${user.id})`);
  } else {
    console.log(`✅ User already exists: ${user.email} (${user.id})`);
  }

  // Create or find the references organization
  // Look for an organization where the user is a member and the title is "References"
  let organization = await prisma.organization.findFirst({
    where: {
      title: "References",
      members: {
        some: {
          userId: user.id,
        },
      },
    },
  });

  if (!organization) {
    console.log("Creating references organization...");
    organization = await createOrganization({
      title: "References",
      userId: user.id,
      companySize: "1-10",
    });
    console.log(`✅ Created organization: ${organization.title} (${organization.slug})`);
  } else {
    console.log(`✅ Organization already exists: ${organization.title} (${organization.slug})`);
  }

  // Define the reference projects with their specific project refs
  const referenceProjects = [
    {
      name: "hello-world",
      externalRef: "proj_rrkpdguyagvsoktglnod",
    },
    {
      name: "d3-chat",
      externalRef: "proj_cdmymsrobxmcgjqzhdkq",
    },
    {
      name: "realtime-streams",
      externalRef: "proj_klxlzjnzxmbgiwuuwhvb",
    },
  ];

  // Create or find each project
  for (const projectConfig of referenceProjects) {
    await findOrCreateProject(projectConfig.name, organization, user.id, projectConfig.externalRef);
  }

  await createBatchLimitOrgs(user);

  console.log("\n🎉 Seed complete!\n");
  console.log("Summary:");
  console.log(`User: ${user.email}`);
  console.log(`Organization: ${organization.title} (${organization.slug})`);
  console.log(`Projects: ${referenceProjects.map((p) => p.name).join(", ")}`);
  console.log("\n⚠️  Note: Update the .env files in d3-chat and realtime-streams with:");
  console.log(`  - d3-chat: TRIGGER_PROJECT_REF=proj_cdmymsrobxmcgjqzhdkq`);
  console.log(`  - realtime-streams: TRIGGER_PROJECT_REF=proj_klxlzjnzxmbgiwuuwhvb`);
}

async function createBatchLimitOrgs(user: User) {
  const org1 = await findOrCreateOrganization("batch-limit-org-1", user, {
    batchQueueConcurrencyConfig: { processingConcurrency: 1 },
  });
  const org2 = await findOrCreateOrganization("batch-limit-org-2", user, {
    batchQueueConcurrencyConfig: { processingConcurrency: 5 },
  });
  const org3 = await findOrCreateOrganization("batch-limit-org-3", user, {
    batchQueueConcurrencyConfig: { processingConcurrency: 10 },
  });

  // Create 3 projects in each organization
  const org1Project1 = await findOrCreateProject("batch-limit-project-1", org1, user.id);
  const org1Project2 = await findOrCreateProject("batch-limit-project-2", org1, user.id);
  const org1Project3 = await findOrCreateProject("batch-limit-project-3", org1, user.id);

  const org2Project1 = await findOrCreateProject("batch-limit-project-1", org2, user.id);
  const org2Project2 = await findOrCreateProject("batch-limit-project-2", org2, user.id);
  const org2Project3 = await findOrCreateProject("batch-limit-project-3", org2, user.id);

  const org3Project1 = await findOrCreateProject("batch-limit-project-1", org3, user.id);
  const org3Project2 = await findOrCreateProject("batch-limit-project-2", org3, user.id);
  const org3Project3 = await findOrCreateProject("batch-limit-project-3", org3, user.id);

  console.log("tenants.json");
  console.log(
    JSON.stringify({
      apiUrl: "http://localhost:3030",
      tenants: [
        {
          id: org1Project1.project.externalRef,
          secretKey: org1Project1.environments.find((e) => e.type === "DEVELOPMENT")?.apiKey,
        },
        {
          id: org1Project2.project.externalRef,
          secretKey: org1Project2.environments.find((e) => e.type === "DEVELOPMENT")?.apiKey,
        },
        {
          id: org1Project3.project.externalRef,
          secretKey: org1Project3.environments.find((e) => e.type === "DEVELOPMENT")?.apiKey,
        },
        {
          id: org2Project1.project.externalRef,
          secretKey: org2Project1.environments.find((e) => e.type === "DEVELOPMENT")?.apiKey,
        },
        {
          id: org2Project2.project.externalRef,
          secretKey: org2Project2.environments.find((e) => e.type === "DEVELOPMENT")?.apiKey,
        },
        {
          id: org2Project3.project.externalRef,
          secretKey: org2Project3.environments.find((e) => e.type === "DEVELOPMENT")?.apiKey,
        },
        {
          id: org3Project1.project.externalRef,
          secretKey: org3Project1.environments.find((e) => e.type === "DEVELOPMENT")?.apiKey,
        },
        {
          id: org3Project2.project.externalRef,
          secretKey: org3Project2.environments.find((e) => e.type === "DEVELOPMENT")?.apiKey,
        },
        {
          id: org3Project3.project.externalRef,
          secretKey: org3Project3.environments.find((e) => e.type === "DEVELOPMENT")?.apiKey,
        },
      ],
    })
  );
}

seed()
  .catch((e) => {
    console.error("❌ Seed failed:");
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

async function findOrCreateOrganization(
  title: string,
  user: User,
  updates?: Prisma.OrganizationUpdateInput
) {
  let organization = await prisma.organization.findFirst({
    where: {
      title: title,
      members: {
        some: {
          userId: user.id,
        },
      },
    },
  });

  if (!organization) {
    console.log(`Creating organization: ${title}...`);
    organization = await createOrganization({
      title: title,
      userId: user.id,
      companySize: "1-10",
    });
  }

  if (updates) {
    organization = await prisma.organization.update({
      where: { id: organization.id },
      data: updates,
    });
  }

  return organization;
}

async function findOrCreateProject(
  name: string,
  organization: Organization,
  userId: string,
  externalRef?: string
) {
  let project = await prisma.project.findFirst({
    where: {
      name,
      organizationId: organization.id,
    },
  });

  if (!project) {
    console.log(`Creating project: ${name}...`);
    project = await createProject({
      organizationSlug: organization.slug,
      name,
      userId,
      version: "v3",
    });

    if (externalRef) {
      project = await prisma.project.update({
        where: { id: project.id },
        data: { externalRef },
      });
    }
  }

  console.log(`✅ Project ready: ${project.name} (${project.externalRef})`);

  // list environments for this project
  const environments = await prisma.runtimeEnvironment.findMany({
    where: { projectId: project.id },
    select: {
      slug: true,
      type: true,
      apiKey: true,
    },
  });
  console.log(`   Environments for ${project.name}:`);
  for (const env of environments) {
    console.log(`   - ${env.type.toLowerCase()} (${env.slug}): ${env.apiKey}`);
  }

  return { project, environments };
}
