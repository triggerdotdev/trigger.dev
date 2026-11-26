import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const STATE = vi.hoisted(() => ({
  canWriteTasks: false,
  upserts: 0,
  deletes: 0,
  activeChanges: [] as boolean[],
}));

vi.mock("~/services/session.server", () => ({
  getUserId: async () => "user_1",
  requireUserId: async () => "user_1",
}));
vi.mock("~/services/projectAuthScope.server", () => ({
  resolveProjectAuthScope: async () => ({ organizationId: "org_1", projectId: "proj_1" }),
}));
vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateSession: async () => ({
      ok: true,
      user: { id: "user_1" },
      ability: {
        // A role that can read tasks, and write them only when the test says so.
        can: (action: string, resource: { type: string }) =>
          resource.type === "tasks" && (action === "read" || STATE.canWriteTasks),
        canSuper: () => false,
      },
    }),
  },
}));
vi.mock("~/db.server", () => ({
  prisma: { project: { findUnique: async () => ({ id: "proj_1" }) } },
  $replica: {},
}));
vi.mock("~/models/project.server", () => ({
  findProjectBySlug: async () => ({ id: "proj_1", organizationId: "org_1" }),
}));
vi.mock("~/v3/services/upsertTaskSchedule.server", () => ({
  UpsertTaskScheduleService: class {
    async call() {
      STATE.upserts++;
      return { id: "sched_new" };
    }
  },
}));
vi.mock("~/v3/services/deleteTaskSchedule.server", () => ({
  DeleteTaskScheduleService: class {
    async call() {
      STATE.deletes++;
    }
  },
}));
vi.mock("~/v3/services/setActiveOnTaskSchedule.server", () => ({
  SetActiveOnTaskScheduleService: class {
    async call({ active }: { active: boolean }) {
      STATE.activeChanges.push(active);
    }
  },
}));

let upsertAction: any;
let scheduleAction: any;

beforeAll(async () => {
  upsertAction = (
    await import("~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.new/route")
  ).action;
  scheduleAction = (
    await import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.$scheduleParam/route")
  ).action;
}, 120_000);

beforeEach(() => {
  STATE.canWriteTasks = false;
  STATE.upserts = 0;
  STATE.deletes = 0;
  STATE.activeChanges = [];
});

const params = { organizationSlug: "org", projectParam: "proj", envParam: "prod" };
const scheduleParams = { ...params, scheduleParam: "sched_1" };

function post(fields: Record<string, string>) {
  const body = new FormData();
  body.set("_format", "json");
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return new Request("http://localhost/schedules", { method: "POST", body });
}

async function status(promise: Promise<unknown>) {
  try {
    const result = await promise;
    return result instanceof Response ? result.status : 200;
  } catch (e) {
    return (e as Response).status;
  }
}

const upsertFields = { taskIdentifier: "nightly", cron: "0 9 * * *", environments: "env_1" };

const calls = [
  {
    name: "create",
    run: () => upsertAction({ request: post(upsertFields), params }),
  },
  {
    name: "edit",
    run: () => upsertAction({ request: post({ ...upsertFields, friendlyId: "sched_1" }), params }),
  },
  {
    name: "delete",
    run: () => scheduleAction({ request: post({ action: "delete" }), params: scheduleParams }),
  },
  {
    name: "enable",
    run: () => scheduleAction({ request: post({ action: "enable" }), params: scheduleParams }),
  },
  {
    name: "disable",
    run: () => scheduleAction({ request: post({ action: "disable" }), params: scheduleParams }),
  },
];

describe("dashboard schedule actions need write:tasks", () => {
  it.each(calls)("$name is 403 with read:tasks only and changes nothing", async ({ run }) => {
    expect(await status(run())).toBe(403);
    expect(STATE).toMatchObject({ upserts: 0, deletes: 0, activeChanges: [] });
  });

  it("each action goes through with write:tasks", async () => {
    STATE.canWriteTasks = true;
    for (const { run } of calls) {
      expect(await status(run())).toBe(200);
    }
    expect(STATE).toMatchObject({ upserts: 2, deletes: 1, activeChanges: [true, false] });
  });
});
