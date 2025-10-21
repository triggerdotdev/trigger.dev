import { prisma } from "./app/db.server";
import { createOrganization } from "./app/models/organization.server";
import { createProject } from "./app/models/project.server";
import { AuthenticationMethod } from "@trigger.dev/database";

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
    let project = await prisma.project.findUnique({
      where: { externalRef: projectConfig.externalRef },
    });

    if (!project) {
      console.log(`Creating project: ${projectConfig.name}...`);
      project = await createProject({
        organizationSlug: organization.slug,
        name: projectConfig.name,
        userId: user.id,
        version: "v3",
      });

      // Update the externalRef to match the expected value
      project = await prisma.project.update({
        where: { id: project.id },
        data: { externalRef: projectConfig.externalRef },
      });

      console.log(`✅ Created project: ${project.name} (${project.externalRef})`);
    } else {
      console.log(`✅ Project already exists: ${project.name} (${project.externalRef})`);
    }

    // List the environments for this project
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
  }

  console.log("\n🎉 Seed complete!\n");
  console.log("Summary:");
  console.log(`User: ${user.email}`);
  console.log(`Organization: ${organization.title} (${organization.slug})`);
  console.log(`Projects: ${referenceProjects.map((p) => p.name).join(", ")}`);
  console.log("\n⚠️  Note: Update the .env files in d3-chat and realtime-streams with:");
  console.log(`  - d3-chat: TRIGGER_PROJECT_REF=proj_cdmymsrobxmcgjqzhdkq`);
  console.log(`  - realtime-streams: TRIGGER_PROJECT_REF=proj_klxlzjnzxmbgiwuuwhvb`);
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
