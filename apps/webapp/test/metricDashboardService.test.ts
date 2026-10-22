import { describe, expect, it, vi } from "vitest";
import { postgresTest } from "@internal/testcontainers";
import type { DashboardWidgetInput } from "@trigger.dev/core/v3/schemas";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";
import { builtInDashboard } from "~/presenters/v3/BuiltInDashboards.server";

import {
  assertValidWidgetQueries,
  MetricDashboardService,
  dashboardRevision,
  toDashboardObject,
} from "~/v3/services/metricDashboard.server";

vi.setConfig({ testTimeout: 60_000 });

const limits = async () => ({ dashboards: 3, widgetsPerDashboard: 2 });

const chart = (id: string, extra: Partial<DashboardWidgetInput> = {}) => ({
  id,
  title: `Chart ${id}`,
  query: "SELECT count() FROM runs",
  display: {
    type: "chart" as const,
    chartType: "bar" as const,
    xAxisColumn: null,
    yAxisColumns: ["count"],
    groupByColumn: null,
    stacked: false,
    sortByColumn: null,
    sortDirection: "asc" as const,
    aggregation: "sum" as const,
  },
  ...extra,
});

const heading = (id: string) => ({
  id,
  title: `Section ${id}`,
  query: "",
  display: { type: "title" as const },
});

describe("MetricDashboardService", () => {
  postgresTest("enforces the dashboard limit when creates race", async ({ prisma }) => {
    const { organization, project } = await seedTestEnvironment(prisma);
    const service = new MetricDashboardService(prisma, limits);

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        service.create({
          organizationId: organization.id,
          projectId: project.id,
          title: `Dashboard ${i}`,
        })
      )
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(
      results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason.message)
    ).toEqual(Array(3).fill("Dashboard limit reached"));
    expect(
      await prisma.metricsDashboard.count({ where: { organizationId: organization.id } })
    ).toBe(3);
  });

  postgresTest(
    "places widgets without a position below the positioned ones",
    async ({ prisma }) => {
      const { organization, project } = await seedTestEnvironment(prisma);
      const service = new MetricDashboardService(prisma, limits);

      const created = await service.create({
        organizationId: organization.id,
        projectId: project.id,
        title: "Layout",
        widgets: [
          heading("top"),
          chart("a", { position: { x: 6, y: 0, w: 6, h: 10 } }),
          chart("b"),
        ],
      });

      const object = toDashboardObject(created);
      expect(object.widgets.map((w) => [w.id, w.position])).toEqual([
        ["a", { x: 6, y: 0, w: 6, h: 10 }],
        ["top", { x: 0, y: 10, w: 12, h: 2 }],
        ["b", { x: 0, y: 12, w: 12, h: 15 }],
      ]);
    }
  );

  postgresTest("does not count title widgets against the widget limit", async ({ prisma }) => {
    const { organization, project } = await seedTestEnvironment(prisma);
    const service = new MetricDashboardService(prisma, limits);
    const ref = { organizationId: organization.id, projectId: project.id };

    const dashboard = await service.create({
      ...ref,
      title: "Limits",
      widgets: [chart("a"), heading("h1"), chart("b"), heading("h2")],
    });

    await expect(
      service.addWidget({
        organizationId: organization.id,
        friendlyId: dashboard.friendlyId,
        widget: chart("c"),
      })
    ).rejects.toThrow("Widget limit reached");

    const { widgetId } = await service.addWidget({
      organizationId: organization.id,
      friendlyId: dashboard.friendlyId,
      widget: heading("h3"),
    });
    expect(widgetId).toBe("h3");

    await expect(
      service.create({ ...ref, title: "Too many", widgets: [chart("a"), chart("b"), chart("c")] })
    ).rejects.toThrow("Widget limit reached");
  });

  postgresTest("rejects a write made against a stale revision", async ({ prisma }) => {
    const { organization, project } = await seedTestEnvironment(prisma);
    const service = new MetricDashboardService(prisma, limits);

    const dashboard = await service.create({
      organizationId: organization.id,
      projectId: project.id,
      title: "Revisions",
    });
    const ref = { organizationId: organization.id, friendlyId: dashboard.friendlyId };
    const stale = dashboardRevision(dashboard);

    const renamed = await service.update({ ...ref, title: "Renamed", revision: stale });
    expect(renamed.title).toBe("Renamed");

    await expect(service.update({ ...ref, title: "Again", revision: stale })).rejects.toThrow(
      /modified by another request/
    );
    await expect(
      service.replace({ ...ref, widgets: [chart("a")], revision: stale })
    ).rejects.toThrow(/modified by another request/);

    const replaced = await service.replace({
      ...ref,
      widgets: [chart("a")],
      revision: dashboardRevision(renamed),
    });
    expect(toDashboardObject(replaced).widgets.map((w) => w.id)).toEqual(["a"]);
  });

  postgresTest(
    "keeps existing grid hints and rejects duplicate widget ids on replace",
    async ({ prisma }) => {
      const { organization, project } = await seedTestEnvironment(prisma);
      const service = new MetricDashboardService(prisma, limits);

      const dashboard = await service.create({
        organizationId: organization.id,
        projectId: project.id,
        title: "Replace",
        widgets: [chart("a")],
      });
      const ref = { organizationId: organization.id, friendlyId: dashboard.friendlyId };

      await service.saveLayout({ ...ref, layout: [{ i: "a", x: 0, y: 0, w: 12, h: 15, minH: 4 }] });
      const replaced = await service.replace({
        ...ref,
        widgets: [chart("a", { position: { x: 0, y: 0, w: 6, h: 8 } })],
      });
      expect(JSON.parse(replaced.layout).layout).toEqual([
        { i: "a", x: 0, y: 0, w: 6, h: 8, minH: 4 },
      ]);

      await expect(service.replace({ ...ref, widgets: [chart("a"), chart("a")] })).rejects.toThrow(
        'Duplicate widget id "a"'
      );
    }
  );

  postgresTest(
    "counts a title widget turned into a chart against the limit",
    async ({ prisma }) => {
      const { organization, project } = await seedTestEnvironment(prisma);
      const service = new MetricDashboardService(prisma, limits);

      const dashboard = await service.create({
        organizationId: organization.id,
        projectId: project.id,
        title: "Convert",
        widgets: [chart("a"), chart("b"), heading("h")],
      });
      const ref = { organizationId: organization.id, friendlyId: dashboard.friendlyId };

      await expect(
        service.updateWidget({
          ...ref,
          widgetId: "h",
          changes: {
            query: "SELECT count() FROM runs",
            display: { type: "table", prettyFormatting: true, sorting: [] },
          },
        })
      ).rejects.toThrow("Widget limit reached");

      const switched = await service.updateWidget({
        ...ref,
        widgetId: "a",
        changes: { display: { type: "table", prettyFormatting: true, sorting: [] } },
      });
      expect(JSON.parse(switched.layout).widgets.a.display.type).toBe("table");
    }
  );

  postgresTest("refuses to duplicate onto an existing widget id", async ({ prisma }) => {
    const { organization, project } = await seedTestEnvironment(prisma);
    const service = new MetricDashboardService(prisma, async () => ({
      dashboards: 3,
      widgetsPerDashboard: 10,
    }));

    const dashboard = await service.create({
      organizationId: organization.id,
      projectId: project.id,
      title: "Duplicate",
      widgets: [chart("a"), chart("b")],
    });

    await expect(
      service.duplicateWidget({
        organizationId: organization.id,
        friendlyId: dashboard.friendlyId,
        widgetId: "a",
        newWidgetId: "b",
      })
    ).rejects.toThrow('A widget with id "b" already exists');

    const stored = await service.get({
      organizationId: organization.id,
      friendlyId: dashboard.friendlyId,
    });
    expect(JSON.parse(stored.layout).widgets.b.title).toBe("Chart b");
  });

  postgresTest(
    "keeps an existing widget's position when replace leaves it out",
    async ({ prisma }) => {
      const { organization, project } = await seedTestEnvironment(prisma);
      const service = new MetricDashboardService(prisma, limits);

      const dashboard = await service.create({
        organizationId: organization.id,
        projectId: project.id,
        title: "Positions",
        widgets: [chart("a", { position: { x: 6, y: 0, w: 6, h: 8 } })],
      });

      const replaced = await service.replace({
        organizationId: organization.id,
        friendlyId: dashboard.friendlyId,
        widgets: [chart("a", { title: "Renamed" }), chart("b")],
      });

      expect(toDashboardObject(replaced).widgets.map((w) => [w.id, w.position])).toEqual([
        ["a", { x: 6, y: 0, w: 6, h: 8 }],
        ["b", { x: 0, y: 8, w: 12, h: 15 }],
      ]);
    }
  );

  postgresTest("scopes lookups to the organization", async ({ prisma }) => {
    const owner = await seedTestEnvironment(prisma);
    const other = await seedTestEnvironment(prisma);
    const service = new MetricDashboardService(prisma, limits);

    const dashboard = await service.create({
      organizationId: owner.organization.id,
      projectId: owner.project.id,
      title: "Private",
    });

    await expect(
      service.delete({ organizationId: other.organization.id, friendlyId: dashboard.friendlyId })
    ).rejects.toThrow("Dashboard not found");
    expect(await prisma.metricsDashboard.count({ where: { id: dashboard.id } })).toBe(1);
  });
});

describe("assertValidWidgetQueries", () => {
  it("rejects queries against unknown tables or columns", () => {
    for (const query of [
      "SELECT count() FROM nope",
      "SELECT not_a_column FROM runs",
      "SELECT count( FROM runs",
    ]) {
      expect(() => assertValidWidgetQueries([chart("bad", { query })]), query).toThrow(
        /Widget "bad" has an invalid query/
      );
    }
  });

  it("accepts every query on the built-in dashboards", () => {
    for (const key of ["overview", "llm"]) {
      const widgets = Object.entries(builtInDashboard(key).layout.widgets).map(([id, widget]) => ({
        id,
        ...widget,
      }));
      expect(() => assertValidWidgetQueries(widgets), key).not.toThrow();
    }
  });

  it("rejects a widget whose query does not parse", () => {
    expect(() => assertValidWidgetQueries([chart("ok"), heading("h")])).not.toThrow();
    expect(() =>
      assertValidWidgetQueries([chart("bad", { query: "SELECT count( FROM runs" })])
    ).toThrow(/Widget "bad" has an invalid query/);
  });
});
