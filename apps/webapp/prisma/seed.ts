/* eslint-disable turbo/no-undeclared-env-vars */
import { PrismaClient } from "@trigger.dev/database";
import { integrationCatalog } from "../app/services/externalApis/integrationCatalog.server";

const prisma = new PrismaClient();

const GITHUB_CONNECTION_KEY = "github-seed-key";
const SLACK_CONNECTION_KEY = "slack-seed-key";

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

  // TODO: extract this into a separate file and put it behind some kind of env var
  // Create a user, organization, and project
  const user = await prisma.user.upsert({
    where: {
      email: "eric@trigger.dev",
    },
    create: {
      email: "eric@trigger.dev",
      name: "Eric",
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
    },
    update: {},
  });

  await prisma.runtimeEnvironment.upsert({
    where: {
      apiKey: "tr_prod_bNaLxayOXqoj",
    },
    create: {
      apiKey: "tr_prod_bNaLxayOXqoj",
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
    },
    update: {},
  });

  // Now we need to create a couple of Integrations
  const slackIntegration = await prisma.integration.upsert({
    where: {
      organizationId_slug: {
        organizationId: organization.id,
        slug: "my-slack-new",
      },
    },
    create: {
      organization: {
        connect: {
          id: organization.id,
        },
      },
      definition: {
        connect: {
          id: "slack",
        },
      },
      slug: "my-slack-new",
      title: "My Slack",
      scopes: ["chat:write"],
      authSource: "HOSTED",
      connectionType: "DEVELOPER",
      authMethod: {
        connect: {
          definitionId_key: {
            definitionId: "slack",
            key: "oauth2Bot",
          },
        },
      },
    },
    update: {},
  });

  const githubIntegration = await prisma.integration.upsert({
    where: {
      organizationId_slug: {
        organizationId: organization.id,
        slug: "github",
      },
    },
    create: {
      organization: {
        connect: {
          id: organization.id,
        },
      },
      definition: {
        connect: {
          id: "github",
        },
      },
      slug: "github",
      title: "GitHub",
      scopes: ["admin:repo_hook", "public_repo"],
      authSource: "HOSTED",
      connectionType: "DEVELOPER",
      authMethod: {
        connect: {
          definitionId_key: {
            definitionId: "github",
            key: "oauth2",
          },
        },
      },
    },
    update: {},
  });

  await prisma.integrationConnection.upsert({
    where: {
      id: "clhkhsvx20000rmdy9u9d25e7",
    },
    create: {
      id: "clhkhsvx20000rmdy9u9d25e7",
      metadata: {},
      integration: {
        connect: {
          id: githubIntegration.id,
        },
      },
      organization: {
        connect: {
          id: organization.id,
        },
      },
      connectionType: "DEVELOPER",
      dataReference: {
        connectOrCreate: {
          where: {
            key: GITHUB_CONNECTION_KEY,
          },
          create: {
            key: GITHUB_CONNECTION_KEY,
            provider: "DATABASE",
          },
        },
      },
    },
    update: {},
  });

  await prisma.integrationConnection.upsert({
    where: {
      id: "clhkigzf90000rmdyfuiec6ew",
    },
    create: {
      id: "clhkigzf90000rmdyfuiec6ew",
      metadata: { account: "Trigger.dev" },
      integration: {
        connect: {
          id: slackIntegration.id,
        },
      },
      organization: {
        connect: {
          id: organization.id,
        },
      },
      connectionType: "DEVELOPER",
      dataReference: {
        connectOrCreate: {
          where: {
            key: SLACK_CONNECTION_KEY,
          },
          create: {
            key: SLACK_CONNECTION_KEY,
            provider: "DATABASE",
          },
        },
      },
    },
    update: {},
  });

  await prisma.secretStore.upsert({
    where: {
      key: GITHUB_CONNECTION_KEY,
    },
    create: {
      key: GITHUB_CONNECTION_KEY,
      value: {
        raw: {
          scope: "admin:repo_hook,public_repo",
          token_type: "bearer",
          access_token: process.env.SEED_GITHUB_ACCESS_TOKEN,
        },
        type: "oauth2",
        scopes: ["admin:repo_hook,public_repo"],
        accessToken: process.env.SEED_GITHUB_ACCESS_TOKEN,
      },
    },
    update: {},
  });

  await prisma.secretStore.upsert({
    where: {
      key: SLACK_CONNECTION_KEY,
    },
    create: {
      key: SLACK_CONNECTION_KEY,
      value: {
        raw: {
          ok: true,
          team: { id: "T84AW8RBP", name: "Trigger.dev" },
          scope:
            "chat:write,channels:read,channels:manage,im:write,channels:join,chat:write.customize,bookmarks:read",
          app_id: "A04H149K884",
          enterprise: null,
          token_type: "bot",
          authed_user: { id: "U8590FPB9" },
          bot_user_id: "U04H0UUQPHR",
          access_token: process.env.SEED_SLACK_ACCESS_TOKEN,
          is_enterprise_install: false,
        },
        type: "oauth2",
        scopes: [
          "chat:write",
          "channels:read",
          "channels:manage",
          "im:write",
          "channels:join",
          "chat:write.customize",
          "bookmarks:read",
        ],
        accessToken: process.env.SEED_SLACK_ACCESS_TOKEN,
      },
    },
    update: {},
  });

  const userGithubIntegration = await prisma.integration.upsert({
    where: {
      organizationId_slug: {
        organizationId: organization.id,
        slug: "github-user",
      },
    },
    create: {
      definition: {
        connect: {
          id: "github",
        },
      },
      slug: "github-user",
      title: "GitHub User",
      scopes: ["admin:repo_hook", "public_repo"],
      authSource: "HOSTED",
      connectionType: "EXTERNAL",
      authMethod: {
        connect: {
          definitionId_key: {
            definitionId: "github",
            key: "oauth2",
          },
        },
      },
      organization: {
        connect: {
          id: organization.id,
        },
      },
    },
    update: {},
  });

  const externalAccount1Identifier = "eric1234";

  const externalAccount1 = await prisma.externalAccount.upsert({
    where: {
      environmentId_identifier: {
        environmentId: devEnv.id,
        identifier: externalAccount1Identifier,
      },
    },
    create: {
      organizationId: organization.id,
      environmentId: devEnv.id,
      identifier: externalAccount1Identifier,
      metadata: { foo: "bar" },
    },
    update: {},
  });

  const externalAccount2Identifier = "matt1234";

  const externalAccount2 = await prisma.externalAccount.upsert({
    where: {
      environmentId_identifier: {
        environmentId: devEnv.id,
        identifier: externalAccount2Identifier,
      },
    },
    create: {
      organizationId: organization.id,
      environmentId: devEnv.id,
      identifier: externalAccount2Identifier,
      metadata: { bar: "baz" },
    },
    update: {},
  });

  await prisma.integrationConnection.upsert({
    where: {
      id: "cli1qcroy0000b4dy084m2jsr",
    },
    create: {
      id: "cli1qcroy0000b4dy084m2jsr",
      externalAccount: {
        connect: {
          id: externalAccount1.id,
        },
      },
      metadata: {},
      integration: {
        connect: {
          id: userGithubIntegration.id,
        },
      },
      organization: {
        connect: {
          id: organization.id,
        },
      },
      connectionType: "EXTERNAL",
      dataReference: {
        connectOrCreate: {
          where: {
            key: `${externalAccount1Identifier}-github`,
          },
          create: {
            key: `${externalAccount1Identifier}-github`,
            provider: "DATABASE",
          },
        },
      },
    },
    update: {},
  });

  await prisma.secretStore.upsert({
    where: {
      key: `${externalAccount1Identifier}-github`,
    },
    create: {
      key: `${externalAccount1Identifier}-github`,
      value: {
        raw: {
          scope: "admin:repo_hook,public_repo",
          token_type: "bearer",
          access_token: process.env.SEED_USER_GITHUB_ACCESS_TOKEN,
        },
        type: "oauth2",
        scopes: ["admin:repo_hook,public_repo"],
        accessToken: process.env.SEED_USER_GITHUB_ACCESS_TOKEN,
      },
    },
    update: {},
  });
}

seed()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
