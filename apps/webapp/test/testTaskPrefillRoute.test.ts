import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  presenterCall: vi.fn(),
}));

vi.mock("~/services/session.server", () => ({
  requireUser: vi.fn(async () => ({ id: "user_1", admin: false, isImpersonating: false })),
}));
vi.mock("~/models/project.server", () => ({
  findProjectBySlug: vi.fn(async () => ({ id: "proj_1", organizationId: "org_1" })),
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: vi.fn(async () => ({ id: "env_1", type: "DEVELOPMENT", slug: "dev" })),
}));
vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: { getClickhouseForOrganization: vi.fn(async () => ({})) },
}));
vi.mock("~/presenters/v3/TestTaskPresenter.server", () => ({
  TestTaskPresenter: class {
    call = mocks.presenterCall;
  },
}));
vi.mock("~/presenters/v3/RegionsPresenter.server", () => ({
  RegionsPresenter: class {
    call = async () => ({ regions: [] });
  },
}));
vi.mock("~/env.server", () => ({ env: {} }));
vi.mock("~/models/message.server", () => ({
  redirectBackWithErrorMessage: vi.fn(),
  redirectWithErrorMessage: vi.fn(),
  redirectWithSuccessMessage: vi.fn(),
}));
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
vi.mock("~/services/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("~/v3/services/testTask.server", () => ({ TestTaskService: class {} }));
vi.mock("~/v3/services/taskRunTemplate.server", () => ({ TaskRunTemplateService: class {} }));
vi.mock("~/v3/services/deleteTaskRunTemplate.server", () => ({
  DeleteTaskRunTemplateService: class {},
}));
vi.mock("~/v3/services/triggerTask.server", () => ({ OutOfEntitlementError: class {} }));

import { loader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.test.tasks.$taskParam/route";

const params = {
  organizationSlug: "acme",
  projectParam: "hello-proj",
  envParam: "dev",
  taskParam: "hello-world",
};

async function load(search: string) {
  const request = new Request(
    `https://cloud.trigger.dev/orgs/acme/projects/hello-proj/env/dev/test/tasks/hello-world${search}`
  );
  const response = (await loader({ request, params, context: {} })) as Response;
  // Raw typedjson: an undefined prefill is null here (the client restores undefined).
  return (await response.json()) as { foundTask: boolean; prefillPayload: string | null };
}

const payloadParam = (json: string) => `?payload=${Buffer.from(json).toString("base64url")}`;

describe("Test task page loader prefill", () => {
  beforeEach(() => {
    mocks.presenterCall.mockReset();
    mocks.presenterCall.mockResolvedValue({ foundTask: true, triggerSource: "STANDARD", runs: [] });
  });

  it("returns a valid payload param pretty-printed for the editor", async () => {
    const data = await load(payloadParam('{"message":"Hello"}'));
    expect(data.prefillPayload).toBe('{\n  "message": "Hello"\n}');
  });

  it("drops a payload past the size limit", async () => {
    const data = await load(payloadParam(JSON.stringify("x".repeat(5000))));
    expect(data.foundTask).toBe(true);
    expect(data.prefillPayload).toBeNull();
  });

  it("drops a payload that isn't JSON", async () => {
    const data = await load(payloadParam("{ message: Hello }"));
    expect(data.prefillPayload).toBeNull();
  });

  // Catches: a docs link to a task the environment doesn't have throwing instead of rendering the
  // not-found panel (the payload stays, so it prefills after the reader runs dev and reloads).
  it("loads the missing-task state with the payload kept", async () => {
    mocks.presenterCall.mockResolvedValue({ foundTask: false });
    const data = await load(payloadParam('{"message":"Hello"}'));
    expect(data.foundTask).toBe(false);
    expect(data.prefillPayload).toBe('{\n  "message": "Hello"\n}');
  });
});
