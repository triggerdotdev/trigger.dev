/* eslint-disable turbo/no-undeclared-env-vars */

import { integrationCatalog } from "../app/services/externalApis/integrationCatalog.server";
import { seedCloud } from "./seedCloud";
import { prisma } from "../app/db.server";
import { createEnvironment } from "~/models/organization.server";

async function seedIntegrationAuthMethods() {
  for (const [_, integration] of Object.entries(integrationCatalog.getIntegrations())) {
    await prisma.integrationDefinition.upsert({
      where: {
        id: integration.identifier,
      },
      create: {
        id: integration.identifier,
        name: integration.name,
        icon: integration.icon ?? integration.identifier,
        instructions: "Instructions go here",
        description: integration.description,
        packageName: integration.packageName,
      },
      update: {
        name: integration.name,
        description: integration.description,
        packageName: integration.packageName,
        icon: integration.icon ?? integration.identifier,
      },
    });

    for (const [key, authMethod] of Object.entries(integration.authenticationMethods)) {
      if (authMethod.type === "oauth2") {
        console.log(`Upserting auth method ${integration.identifier}.${key}`);

        await prisma.integrationAuthMethod.upsert({
          where: {
            definitionId_key: {
              definitionId: integration.identifier,
              key,
            },
          },
          create: {
            key,
            name: authMethod.name,
            description: authMethod.description ?? "",
            type: authMethod.type,
            client: authMethod.client,
            config: authMethod.config,
            scopes: authMethod.scopes,
            definition: {
              connect: {
                id: integration.identifier,
              },
            },
            help: authMethod.help,
          },
          update: {
            name: authMethod.name,
            description: authMethod.description ?? "",
            type: authMethod.type,
            client: authMethod.client,
            config: authMethod.config,
            scopes: authMethod.scopes,
            help: authMethod.help,
          },
        });
      }
    }
  }
}

async function runDataMigrations() {
  await runStagingEnvironmentMigration();
}

async function runStagingEnvironmentMigration() {
  try {
    await prisma.$transaction(async (tx) => {
      const existingDataMigration = await tx.dataMigration.findUnique({
        where: {
          name: "2023-09-27-AddStagingEnvironments",
        },
      });

      if (existingDataMigration) {
        return;
      }

      await tx.dataMigration.create({
        data: {
          name: "2023-09-27-AddStagingEnvironments",
        },
      });

      console.log("Running data migration 2023-09-27-AddStagingEnvironments");

      const projectsWithoutStagingEnvironments = await tx.project.findMany({
        where: {
          environments: {
            none: {
              type: "STAGING",
            },
          },
        },
        include: {
          organization: true,
        },
      });

      for (const project of projectsWithoutStagingEnvironments) {
        try {
          console.log(
            `Creating staging environment for project ${project.slug} on org ${project.organization.slug}`
          );

          await createEnvironment(project.organization, project, "STAGING", undefined, tx);
        } catch (error) {
          console.error(error);
        }
      }

      await tx.dataMigration.update({
        where: {
          name: "2023-09-27-AddStagingEnvironments",
        },
        data: {
          completedAt: new Date(),
        },
      });
    });
  } catch (error) {
    console.error(error);
  }
}

async function seed() {
  await seedIntegrationAuthMethods();

  if (process.env.NODE_ENV === "development" && process.env.SEED_CLOUD === "enabled") {
    await seedCloud(prisma);
  }

  await runDataMigrations();
}

seed()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
