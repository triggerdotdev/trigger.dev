import { describe, expect, it, vi } from "vitest";

vi.mock("~/services/session.server", () => ({ requireUserId: async () => "user_1" }));
vi.mock("~/models/project.server", () => ({
  findProjectBySlug: async (org: string) => (org === "org" ? { id: "proj_1" } : null),
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async () => ({ id: "env_1" }),
}));
vi.mock("~/services/taskIdentifierRegistry.server", () => ({
  getTaskIdentifiers: async (environmentId: string) =>
    environmentId === "env_1"
      ? [
          { slug: "send-email", triggerSource: "STANDARD", isInLatestDeployment: true },
          { slug: "nightly", triggerSource: "SCHEDULED", isInLatestDeployment: true },
          { slug: "removed-task", triggerSource: "STANDARD", isInLatestDeployment: false },
        ]
      : [],
}));

const { loader } =
  await import("~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.tasks");

const params = { organizationSlug: "org", projectParam: "proj", envParam: "dev" };
const request = () => new Request("http://localhost/resources/tasks");

describe("tasks resource route", () => {
  it("returns the current deployment's task identifiers", async () => {
    const result = await loader({ request: request(), params, context: {} });
    expect(result).toEqual({
      tasks: [
        { slug: "send-email", triggerSource: "STANDARD" },
        { slug: "nightly", triggerSource: "SCHEDULED" },
      ],
    });
  });

  it("404s for an unknown project", async () => {
    await expect(
      loader({ request: request(), params: { ...params, organizationSlug: "other" }, context: {} })
    ).rejects.toMatchObject({ status: 404 });
  });
});
