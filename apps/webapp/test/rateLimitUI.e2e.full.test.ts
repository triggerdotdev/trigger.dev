import { describe, expect, it } from "vitest";
import { getTestServer } from "./helpers/sharedTestServer";
import { seedTestSession } from "./helpers/seedTestSession";
import { seedTestUserProject } from "./helpers/seedTestUserProject";

describe("Rate Limiting UI", () => {
  it("should override and remove queue limits via the UI action", async () => {
    const server = getTestServer();
    const { user, organization, project, environment } = await seedTestUserProject(server.prisma);
    await server.prisma.user.update({
      where: { id: user.id },
      data: { confirmedBasicDetails: true },
    });
    const cookie = await seedTestSession({ userId: user.id });

    // Get the org member
    const orgMember = await server.prisma.orgMember.findFirst({
      where: { userId: user.id, organizationId: organization.id },
    });

    // Update environment to have a high maximumConcurrencyLimit and link to orgMember
    await server.prisma.runtimeEnvironment.update({
      where: { id: environment.id },
      data: {
        maximumConcurrencyLimit: 100,
        orgMemberId: orgMember?.id,
      },
    });

    // Create a queue
    const queue = await server.prisma.taskQueue.create({
      data: {
        name: "test-queue",
        friendlyId: "queue_12345",
        type: "NAMED",
        runtimeEnvironmentId: environment.id,
        projectId: project.id,
        concurrencyLimit: 5,
      },
    });

    const path = `/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/queues`;

    // 1. Override limits
    const overrideFormData = new URLSearchParams();
    overrideFormData.append("action", "queue-override");
    overrideFormData.append("friendlyId", queue.friendlyId);
    overrideFormData.append("concurrencyLimit", "5");
    overrideFormData.append("rateLimits", JSON.stringify([{ limit: 10, window: 60 }]));

    const overrideRes = await server.webapp.fetch(path, {
      method: "POST",
      body: overrideFormData.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
      },
      redirect: "manual",
    });

    expect(overrideRes.status).toBe(302);
    const location = overrideRes.headers.get("location");
    if (location?.includes("error")) {
      throw new Error(`Redirected with error: ${location}`);
    }

    // Verify database
    const updatedQueue = await server.prisma.taskQueue.findUnique({
      where: { id: queue.id },
    });

    expect(updatedQueue?.concurrencyLimit).toBe(5);
    expect(updatedQueue?.rateLimit).toEqual([{ limit: 10, window: 60 }]);

    // 2. Remove override
    const removeFormData = new URLSearchParams();
    removeFormData.append("action", "queue-remove-override");
    removeFormData.append("friendlyId", queue.friendlyId);

    const removeRes = await server.webapp.fetch(path, {
      method: "POST",
      body: removeFormData.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
      },
      redirect: "manual",
    });

    expect(removeRes.status).toBe(302);

    // Verify database
    const resetQueue = await server.prisma.taskQueue.findUnique({
      where: { id: queue.id },
    });

    // Concurrency limit is reset to base (which was 5)
    expect(resetQueue?.concurrencyLimit).toBe(5);
    expect(resetQueue?.rateLimit).toBe(null);
  });
});
