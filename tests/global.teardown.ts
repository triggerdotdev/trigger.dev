import { setDB } from "./utils";

const teardown = async () => {
  await setDB(async (prisma) => {
    // Delete test organization
    await prisma.organization.delete({
      where: { slug: "test-org" },
    });

    // Delete test user
    await prisma.user.delete({
      where: { email: "test-user@test.com" },
    });
  });
};

export default teardown;
