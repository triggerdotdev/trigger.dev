import type { MetaDescriptor, MetaFunction } from "@remix-run/node";
import { describe, expect, it } from "vitest";
import { appTitle, pageMeta } from "./pageTitle";

const ORGANIZATION_MATCH_ID = "routes/_app.orgs.$organizationSlug";

type Route = { id: string; data?: unknown; meta?: MetaFunction };

/**
 * Mirrors how Remix v2 resolves meta (see @remix-run/react `Meta`): each match is visited from the
 * root down, a match without a meta export inherits the nearest ancestor's array, and the last
 * match's array is what renders. It also only passes the matches visited *so far*, which is why
 * titles are declared per route rather than centrally.
 */
/** The URL params a page inside a project carries; the org scope is dropped when they are present. */
const ENV_PARAMS = { organizationSlug: "acme", projectParam: "my-project", envParam: "prod" };

function renderTitle(
  routes: Route[],
  params: Record<string, string> = ENV_PARAMS
): string | undefined {
  const matches: Array<{ id: string; data: unknown; meta: MetaDescriptor[]; params: any }> = [];
  let leafMeta: MetaDescriptor[] = [];

  routes.forEach((route, index) => {
    matches[index] = { id: route.id, data: route.data, meta: [], params };
    const routeMeta = route.meta
      ? route.meta({ data: route.data, params, matches, location: {} as any } as any)
      : [...leafMeta];
    matches[index].meta = routeMeta as MetaDescriptor[];
    leafMeta = routeMeta as MetaDescriptor[];
  });

  const rendered = leafMeta.find((descriptor) => "title" in descriptor) as
    | { title: string }
    | undefined;
  return rendered?.title;
}

const rootRoute: Route = {
  id: "root",
  data: { appEnv: "production" },
  meta: () => [{ title: appTitle("production") }, { name: "viewport", content: "width=1024" }],
};

const orgRoute: Route = {
  id: ORGANIZATION_MATCH_ID,
  data: {
    organization: { title: "Acme" },
  },
};

describe("pageMeta", () => {
  it("titles a page inside a project without any scope", () => {
    const title = renderTitle([rootRoute, orgRoute, { id: "routes/runs", meta: pageMeta("Runs") }]);

    expect(title).toBe("Runs | Trigger.dev");
  });

  it("uses the deepest declared title", () => {
    const title = renderTitle([
      rootRoute,
      orgRoute,
      { id: "routes/runs", meta: pageMeta("Runs") },
      { id: "routes/runs.$runParam", meta: pageMeta(["run_abc", "Runs"]) },
    ]);

    expect(title).toBe("run_abc | Runs | Trigger.dev");
  });

  it("falls back to the nearest declared title, then the app title", () => {
    expect(
      renderTitle([
        rootRoute,
        orgRoute,
        { id: "routes/runs", meta: pageMeta("Runs") },
        { id: "routes/runs._index" },
      ])
    ).toBe("Runs | Trigger.dev");

    expect(renderTitle([rootRoute, orgRoute, { id: "routes/runs._index" }])).toBe("Trigger.dev");
  });

  it("renders an entity title from loader data, with a fallback when it is missing", () => {
    const meta = pageMeta<() => { task?: { slug: string } }>(({ data, params }) => [
      data?.task?.slug ?? params.taskParam ?? "Task",
      "Tasks",
    ]);

    expect(
      renderTitle([
        rootRoute,
        orgRoute,
        { id: "routes/task", data: { task: { slug: "my-task" } }, meta },
      ])
    ).toBe("my-task | Tasks | Trigger.dev");

    expect(
      renderTitle([rootRoute, orgRoute, { id: "routes/task", meta }], {
        ...ENV_PARAMS,
        taskParam: "other",
      })
    ).toBe("other | Tasks | Trigger.dev");
  });

  it("names the organization on its own pages, with the app env tag", () => {
    const stagingRoot: Route = {
      id: "root",
      data: { appEnv: "staging" },
      meta: () => [{ title: appTitle("staging") }],
    };

    const title = renderTitle(
      [
        stagingRoot,
        { id: ORGANIZATION_MATCH_ID, data: { organization: { title: "Acme" } } },
        { id: "routes/team", meta: pageMeta("Team") },
      ],
      { organizationSlug: "acme" }
    );

    expect(title).toBe("Team | Acme | Trigger.dev (staging)");
  });

  it("carries the root's non-title tags through", () => {
    const routes = [rootRoute, orgRoute, { id: "routes/runs", meta: pageMeta("Runs") }];
    const descriptors = pageMeta("Runs")({
      data: undefined,
      params: {},
      matches: [
        { id: "root", data: rootRoute.data, meta: [{ name: "viewport", content: "width=1024" }] },
        { id: "routes/runs", data: undefined, meta: [] },
      ],
      location: {} as any,
    } as any) as MetaDescriptor[];

    expect(descriptors).toContainEqual({ name: "viewport", content: "width=1024" });
    expect(renderTitle(routes)).toBe("Runs | Trigger.dev");
  });

  it("does not name the organization inside a project", () => {
    // The dashboard switches projects in every tab at once, so the scope adds nothing there.
    expect(renderTitle([rootRoute, orgRoute, { id: "routes/runs", meta: pageMeta("Runs") }])).toBe(
      "Runs | Trigger.dev"
    );
  });
});
