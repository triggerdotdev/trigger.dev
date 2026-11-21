import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const STATE = vi.hoisted(() => ({
  schedule: null as { friendlyId: string; taskIdentifier: string } | null,
  taskPageLoads: 0,
}));

vi.mock("~/services/session.server", () => ({
  getUserId: async () => "user_1",
  requireUserId: async () => "user_1",
}));
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
vi.mock("~/services/projectAuthScope.server", () => ({
  resolveProjectAuthScope: async () => ({ organizationId: "org_1", projectId: "proj_1" }),
}));
vi.mock("~/models/project.server", () => ({
  findProjectBySlug: async () => ({ id: "proj_1", organizationId: "org_1" }),
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async () => ({ id: "env_1", type: "PRODUCTION" }),
}));
vi.mock("~/presenters/v3/ViewSchedulePresenter.server", () => ({
  ViewSchedulePresenter: class {
    async call() {
      return STATE.schedule ? { schedule: STATE.schedule } : undefined;
    }
  },
}));
vi.mock("~/v3/services/deleteTaskSchedule.server", () => ({
  DeleteTaskScheduleService: class {},
}));
vi.mock("~/v3/services/setActiveOnTaskSchedule.server", () => ({
  SetActiveOnTaskScheduleService: class {},
}));
vi.mock("~/presenters/v3/TaskDetailPage.server", () => ({
  loadTaskDetailPage: async () => {
    STATE.taskPageLoads++;
    throw new Response("Not found", { status: 404 });
  },
  taskQueueAction: async () => new Response(null),
}));
vi.mock("~/presenters/v3/ScheduleListPresenter.server", () => ({
  ScheduleListPresenter: class {},
}));

let scheduleLoader: any;
let scheduledTaskLoader: any;

beforeAll(async () => {
  scheduleLoader = (
    await import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.$scheduleParam/route")
  ).loader;
  scheduledTaskLoader = (
    await import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.tasks.scheduled.$taskParam/route")
  ).loader;
}, 120_000);

beforeEach(() => {
  STATE.schedule = { friendlyId: "sched_1", taskIdentifier: "sync.hourly" };
  STATE.taskPageLoads = 0;
});

const params = { organizationSlug: "org", projectParam: "proj", envParam: "prod" };
const schedulePage =
  "/orgs/org/projects/proj/env/prod/tasks/scheduled/sync.hourly/schedules/sched_1";

/** The response a loader returns or throws. */
async function responseOf(promise: Promise<unknown>) {
  try {
    return (await promise) as Response;
  } catch (thrown) {
    return thrown as Response;
  }
}

describe("links to a schedule from before it had a page under its task", () => {
  // Catches: /schedules/<id> (the run page's Schedule link, bookmarks) still opening the old view.
  it("/schedules/<id> goes to the schedule's page", async () => {
    const response = await responseOf(
      scheduleLoader({
        request: new Request("http://localhost/orgs/org/projects/proj/env/prod/schedules/sched_1"),
        params: { ...params, scheduleParam: "sched_1" },
      })
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(schedulePage);
  });

  it("/schedules/<id> for a schedule that is gone says so and doesn't redirect", async () => {
    STATE.schedule = null;
    const response = await responseOf(
      scheduleLoader({
        request: new Request("http://localhost/orgs/org/projects/proj/env/prod/schedules/sched_x"),
        params: { ...params, scheduleParam: "sched_x" },
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();
  });

  // Catches: ?schedule=<id> on the scheduled task's page ignored, landing on the Runs tab.
  it("?schedule=<id> on the scheduled task page goes to the schedule's page", async () => {
    const response = await responseOf(
      scheduledTaskLoader({
        request: new Request(
          "http://localhost/orgs/org/projects/proj/env/prod/tasks/scheduled/sync.hourly?schedule=sched_1"
        ),
        params: { ...params, taskParam: "sync.hourly" },
      })
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(schedulePage);
    expect(STATE.taskPageLoads).toBe(0);
  });

  it("the scheduled task page loads as before without ?schedule", async () => {
    const response = await responseOf(
      scheduledTaskLoader({
        request: new Request(
          "http://localhost/orgs/org/projects/proj/env/prod/tasks/scheduled/sync.hourly?tab=schedules"
        ),
        params: { ...params, taskParam: "sync.hourly" },
      })
    );
    expect(response.status).toBe(404);
    expect(STATE.taskPageLoads).toBe(1);
  });
});
