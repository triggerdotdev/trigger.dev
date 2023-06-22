/* eslint-disable turbo/no-undeclared-env-vars */

import { integrationCatalog } from "../app/services/externalApis/integrationCatalog.server";
import { seedCloud } from "./seedCloud";
import { prisma } from "../app/db.server";

async function seedIntegrationAuthMethods() {
  for (const [identifier, integration] of Object.entries(
    integrationCatalog.getIntegrations()
  )) {
    await prisma.integrationDefinition.upsert({
      where: {
        id: identifier,
      },
      create: {
        id: identifier,
        name: integration.name,
        instructions: "Instructions go here",
      },
      update: {},
    });

    for (const [key, authMethod] of Object.entries(
      integration.authenticationMethods
    )) {
      if (authMethod.type === "oauth2") {
        console.log(`Upserting auth method ${identifier}.${key}`);

        await prisma.integrationAuthMethod.upsert({
          where: {
            definitionId_key: {
              definitionId: identifier,
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
                id: identifier,
              },
            },
          },
          update: {
            name: authMethod.name,
            description: authMethod.description ?? "",
            type: authMethod.type,
            client: authMethod.client,
            config: authMethod.config,
            scopes: authMethod.scopes,
          },
        });
      }
    }
  }
}

async function seed() {
  await seedIntegrationAuthMethods();

  if (
    process.env.NODE_ENV === "development" &&
    process.env.SEED_CLOUD === "enabled"
  ) {
    await seedCloud(prisma);
  }
}

seed()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
