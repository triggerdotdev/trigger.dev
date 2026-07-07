import { prisma } from "./app/db.server";
import { createOrganization } from "./app/models/organization.server";
import { createProject } from "./app/models/project.server";
import type { Organization, Prisma, User } from "@trigger.dev/database";
import { AuthenticationMethod } from "@trigger.dev/database";
import { encryptToken, decryptToken, hashToken } from "./app/utils/tokens.server";
import { env } from "./app/env.server";
import { randomBytes } from "node:crypto";

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

  // Reference projects with their specific project refs. These refs MUST stay in
  // sync with the corresponding projects in the standalone references repo
  // (github.com/triggerdotdev/references): hello-world hardcodes its ref in
  // trigger.config.ts; d3-chat and realtime-streams read TRIGGER_PROJECT_REF.
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
  await ensureDefaultWorkerGroup();

  console.log("\n🎉 Seed complete!\n");
  console.log("Summary:");
  console.log(`User: ${user.email}`);
  console.log(`Organization: ${organization.title} (${organization.slug})`);
  console.log(`Projects: ${referenceProjects.map((p) => p.name).join(", ")}`);

  // The PAT is an admin credential. Only mint and print it when seeding a local
  // instance, so a stray non-local `db:seed` can't leak it to stdout/logs.
  const localHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const isLocalInstance =
    env.NODE_ENV !== "production" && localHostnames.has(new URL(env.APP_ORIGIN).hostname);
  if (isLocalInstance) {
    const localPat = await ensureLocalCliPat(user);
    console.log(`\n🔑 CLI access token for ${user.email} (name: ${localPat.name}):`);
    console.log(`  ${localPat.token}`);
    console.log(`  Point the CLI at this local instance without a browser login:`);
    console.log(`    export TRIGGER_ACCESS_TOKEN=${localPat.token}`);
    console.log(`    export TRIGGER_API_URL=${env.APP_ORIGIN}`);
  }
  console.log("\n⚠️  Note: in your triggerdotdev/references clone, set TRIGGER_PROJECT_REF in:");
  console.log(`  - projects/d3-chat/.env: TRIGGER_PROJECT_REF=proj_cdmymsrobxmcgjqzhdkq`);
  console.log(`  - projects/realtime-streams/.env: TRIGGER_PROJECT_REF=proj_klxlzjnzxmbgiwuuwhvb`);
}

// Mints (or reuses) a Personal Access Token for the seeded local user so the
// CLI can authenticate against this instance without the browser magic-link
// flow. Idempotent: on re-seed we decrypt and reprint the existing token
// rather than piling up new ones. The token is created inline (rather than via
// personalAccessToken.server) so the seed doesn't pull the RBAC/service module
// graph into its import chain.
async function ensureLocalCliPat(user: User) {
  const name = "local-dev-cli";
  const existing = await prisma.personalAccessToken.findFirst({
    where: { userId: user.id, name, revokedAt: null },
  });
  if (existing) {
    const enc = existing.encryptedToken as { nonce: string; ciphertext: string; tag: string };
    return { name, token: decryptToken(enc.nonce, enc.ciphertext, enc.tag, env.ENCRYPTION_KEY) };
  }
  const token = `tr_pat_${randomBytes(20).toString("hex")}`;
  const body = token.slice("tr_pat_".length);
  await prisma.personalAccessToken.create({
    data: {
      name,
      userId: user.id,
      encryptedToken: encryptToken(token, env.ENCRYPTION_KEY),
      hashedToken: hashToken(token),
      obfuscatedToken: `tr_pat_${body.slice(0, 4)}${"•".repeat(18)}${body.slice(-4)}`,
    },
  });
  return { name, token };
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
    process.exit(0);
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

async function ensureDefaultWorkerGroup() {
  // Check if the feature flag already exists
  const existingFlag = await prisma.featureFlag.findUnique({
    where: { key: "defaultWorkerInstanceGroupId" },
  });

  if (existingFlag) {
    console.log(`✅ Default worker instance group already configured`);
    return;
  }

  // Check if a managed worker group already exists
  let workerGroup = await prisma.workerInstanceGroup.findFirst({
    where: { type: "MANAGED" },
  });

  if (!workerGroup) {
    console.log("Creating default worker instance group...");

    const { createHash, randomBytes } = await import("crypto");
    const tokenValue = `tr_wgt_${randomBytes(20).toString("hex")}`;
    const tokenHash = createHash("sha256").update(tokenValue).digest("hex");

    const token = await prisma.workerGroupToken.create({
      data: { tokenHash },
    });

    workerGroup = await prisma.workerInstanceGroup.create({
      data: {
        type: "MANAGED",
        name: "local-dev",
        masterQueue: "local-dev",
        description: "Local development worker group",
        tokenId: token.id,
      },
    });

    console.log(`✅ Created worker instance group: ${workerGroup.name} (${workerGroup.id})`);
  } else {
    console.log(`✅ Worker instance group already exists: ${workerGroup.name} (${workerGroup.id})`);
  }

  // Set the feature flag
  await prisma.featureFlag.upsert({
    where: { key: "defaultWorkerInstanceGroupId" },
    create: {
      key: "defaultWorkerInstanceGroupId",
      value: workerGroup.id,
    },
    update: {
      value: workerGroup.id,
    },
  });

  console.log(`✅ Set defaultWorkerInstanceGroupId feature flag`);
}
