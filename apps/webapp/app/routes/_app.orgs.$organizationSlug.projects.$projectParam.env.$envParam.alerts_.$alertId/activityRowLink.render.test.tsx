import { describe, expect, it } from "vitest";
import { activityRowLink } from "./activityRowLink";

const paths = {
  organization: { slug: "org" },
  project: { slug: "proj" },
  environment: { slug: "dev" },
};
const event = {
  id: "e1",
  type: "raised",
  at: new Date(),
  actorId: null,
  factsSummary: "",
} as never;

const queueAlert = {
  area: "queues",
  windowSec: undefined,
  scope: { type: "queue", queue: "worker-1" },
  objectLink: { kind: "queue", friendlyId: "queue_abc", name: "worker-1" },
} as never;

describe("activityRowLink queue", () => {
  it("links raised rows of a queue-scoped alert to the queue page", () => {
    expect(activityRowLink(queueAlert, event, paths)).toEqual({
      to: "/orgs/org/projects/proj/env/dev/concurrency/queue_abc",
      label: "View queue",
      kind: "queue",
    });
  });

  it("does not link a non-queue scope without a window", () => {
    const alert = { ...(queueAlert as object), scope: { type: "all" }, objectLink: undefined };
    expect(activityRowLink(alert as never, event, paths)).toBeUndefined();
  });
});

describe("activityRowLink runs", () => {
  it("passes the window to the runs page in milliseconds", () => {
    const at = new Date("2026-01-01T00:10:00.000Z");
    const alert = { area: "runs", windowSec: 300, scope: { type: "all" } } as never;
    const link = activityRowLink(alert, { ...(event as object), at } as never, paths);
    const params = new URL(link!.to, "http://x").searchParams;
    expect(params.get("to")).toBe(String(at.getTime()));
    expect(params.get("from")).toBe(String(at.getTime() - 300_000));
  });

  it("filters the runs page to a task-scoped alert's task", () => {
    const alert = {
      area: "runs",
      windowSec: 300,
      scope: { type: "task", taskIdentifier: "my-task" },
    } as never;
    const link = activityRowLink(alert, event, paths);
    expect(new URL(link!.to, "http://x").searchParams.getAll("tasks")).toEqual(["my-task"]);
  });

  it("adds no task filter for an all-scope alert", () => {
    const alert = { area: "runs", windowSec: 300, scope: { type: "all" } } as never;
    const link = activityRowLink(alert, event, paths);
    expect(new URL(link!.to, "http://x").searchParams.has("tasks")).toBe(false);
  });
});
