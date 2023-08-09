import { setDB } from "./utils";

const setup = async () => {
  await setDB(async (prisma) => {
    // Create test user
    const user = await prisma.user.create({
      data: {
        email: "test-user@test.com",
        name: "Test User",
        authenticationMethod: "MAGIC_LINK",
        confirmedBasicDetails: true
      },
    });

    // Create test organization
    const organization = await prisma.organization.create({
      data: {
        title: "Test Organization",
        slug: "test-org",
        members: {
          create: {
            userId: user.id,
            role: "ADMIN",
          },
        },
      },
      include: {
        members: true,
      },
    });

    // Create test project
    const project = await prisma.project.create({
      data: {
        name: "Test Project",
        slug: "test-project",
        organization: {
          connect: {
            slug: organization.slug,
          },
        },
      },
      include: {
        organization: {
          include: {
            members: true,
          },
        },
      },
    });

    // Create test environment
    await prisma.runtimeEnvironment.create({
      data: {
        slug: "dev",
        // Defined in @examples/nextjs-test
        apiKey: "tr_dev_test-api-key",
        pkApiKey: "tr_dev_pk_test-api-key",
        autoEnableInternalSources: false,
        organization: {
          connect: {
            id: organization.id,
          },
        },
        project: {
          connect: {
            id: project.id,
          },
        },
        orgMember: { connect: { id: project.organization.members[0].id } },
        type: "DEVELOPMENT",
      },
    });

    await prisma.runtimeEnvironment.create({
      data: {
        slug: "prod",
        // Defined in @examples/nextjs-test
        apiKey: "tr_prod_test-api-key",
        pkApiKey: "tr_prod_pk_test-api-key",
        autoEnableInternalSources: false,
        organization: {
          connect: {
            id: organization.id,
          },
        },
        project: {
          connect: {
            id: project.id,
          },
        },
        orgMember: { connect: { id: project.organization.members[0].id } },
        type: "PRODUCTION",
      },
    });
  });
};

export default setup;
