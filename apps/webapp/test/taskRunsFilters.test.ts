import { describe, expect, it } from "vitest";
import { taskRunsFilters } from "~/components/tasks/taskRunsFilters";
import { v3CreateBulkActionPath, v3RunsPath } from "~/utils/pathBuilder";

const organization = { slug: "acme" };
const project = { slug: "app" };
const environment = { slug: "prod" };

describe("taskRunsFilters", () => {
  it("is just the task when the page has no time range or versions", () => {
    const filters = taskRunsFilters("send-email", new URLSearchParams("tab=runs"));
    expect(v3RunsPath(organization, project, environment, filters)).toBe(
      "/orgs/acme/projects/app/env/prod/runs?tasks=send-email"
    );
  });

  // Catches: "Bulk replay…" on a task page filtered to an hour and a version opening the bulk
  // action over every version's runs in the runs list's default period.
  it("carries the page's period and versions into the bulk replay link", () => {
    const filters = taskRunsFilters(
      "send-email",
      new URLSearchParams("period=1h&versions=20261101.1&versions=20261101.2&cursor=abc")
    );
    const path = v3CreateBulkActionPath(
      organization,
      project,
      environment,
      filters,
      "filter",
      "replay"
    );
    const params = new URL(path, "http://localhost").searchParams;
    expect(params.getAll("tasks")).toEqual(["send-email"]);
    expect(params.get("period")).toBe("1h");
    expect(params.getAll("versions")).toEqual(["20261101.1", "20261101.2"]);
    expect(params.has("cursor")).toBe(false);
  });

  it("carries an absolute time range and drops values that aren't numbers", () => {
    expect(
      taskRunsFilters("send-email", new URLSearchParams("from=1763500000000&to=1763600000000"))
    ).toMatchObject({ from: 1763500000000, to: 1763600000000 });
    expect(
      taskRunsFilters("send-email", new URLSearchParams("from=yesterday")).from
    ).toBeUndefined();
  });
});
