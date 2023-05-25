/* eslint-disable turbo/no-undeclared-env-vars */
import { PrismaClient } from ".prisma/client";

const prisma = new PrismaClient();

const GITHUB_CONNECTION_KEY = "github-seed-key";
const SLACK_CONNECTION_KEY = "slack-seed-key";

async function seed() {
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

  // Now we need to create a couple of ApiConnectionClients
  const slackClient = await prisma.apiConnectionClient.upsert({
    where: {
      organizationId_slug: {
        organizationId: organization.id,
        slug: "my-slack-new",
      },
    },
    create: {
      organizationId: organization.id,
      slug: "my-slack-new",
      title: "My Slack",
      scopes: ["chat:write"],
      integrationIdentifier: "slack",
      integrationAuthMethod: "oauth2Bot",
    },
    update: {},
  });

  const githubClient = await prisma.apiConnectionClient.upsert({
    where: {
      organizationId_slug: {
        organizationId: organization.id,
        slug: "github",
      },
    },
    create: {
      organizationId: organization.id,
      slug: "github",
      title: "GitHub",
      scopes: ["admin:repo_hook", "public_repo"],
      integrationIdentifier: "github",
      integrationAuthMethod: "oauth2",
    },
    update: {},
  });

  await prisma.apiConnection.upsert({
    where: {
      id: "clhkhsvx20000rmdy9u9d25e7",
    },
    create: {
      id: "clhkhsvx20000rmdy9u9d25e7",
      metadata: { id: "github" },
      client: {
        connect: {
          id: githubClient.id,
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

  await prisma.apiConnection.upsert({
    where: {
      id: "clhkigzf90000rmdyfuiec6ew",
    },
    create: {
      id: "clhkigzf90000rmdyfuiec6ew",
      metadata: { id: "slack" },
      client: {
        connect: {
          id: slackClient.id,
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

  const userGithubClient = await prisma.apiConnectionClient.upsert({
    where: {
      organizationId_slug: {
        organizationId: organization.id,
        slug: "github-user",
      },
    },
    create: {
      organizationId: organization.id,
      slug: "github-user",
      title: "GitHub User",
      scopes: ["admin:repo_hook", "public_repo"],
      integrationIdentifier: "github",
      integrationAuthMethod: "oauth2",
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

  await prisma.apiConnection.upsert({
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
      metadata: { id: "github-user" },
      client: {
        connect: {
          id: userGithubClient.id,
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
