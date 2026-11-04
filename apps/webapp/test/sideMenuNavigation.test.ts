import { describe, expect, it } from "vitest";
import {
  isSideMenuItemActive,
  matchesPath,
  normalizePath,
} from "~/components/navigation/SideMenuItem";

describe("Sidebar Navigation Route Matching", () => {
  const envPath = "/orgs/acme/projects/rocket/env/dev";
  const orgPath = "/orgs/acme";

  describe("normalizePath", () => {
    it("strips trailing slashes, search params, and hashes", () => {
      expect(normalizePath(`${envPath}/`)).toBe(envPath);
      expect(normalizePath(`${envPath}?fav=123`)).toBe(envPath);
      expect(normalizePath(`${envPath}#section`)).toBe(envPath);
      expect(normalizePath(`${envPath}/runs/?filter=failed#top`)).toBe(`${envPath}/runs`);
      expect(normalizePath("/")).toBe("/");
    });
  });

  describe("matchesPath", () => {
    it("matches exact paths", () => {
      expect(matchesPath(`${envPath}/runs`, `${envPath}/runs`)).toBe(true);
      expect(matchesPath(`${envPath}/runs/`, `${envPath}/runs`)).toBe(true);
      expect(matchesPath(`${envPath}/runs`, `${envPath}/runs/`)).toBe(true);
      expect(matchesPath(`${envPath}/runs`, `${envPath}/sessions`)).toBe(false);
    });

    it("matches subpaths only when matchPrefix is true", () => {
      expect(matchesPath(`${envPath}/runs/run_123`, `${envPath}/runs`, false)).toBe(false);
      expect(matchesPath(`${envPath}/runs/run_123`, `${envPath}/runs`, true)).toBe(true);
    });

    it("respects segment boundaries when matchPrefix is true", () => {
      // /concurrency must not match /concurrency-limits
      expect(matchesPath(`${envPath}/concurrency-limits`, `${envPath}/concurrency`, true)).toBe(false);
      expect(matchesPath(`${envPath}/concurrency/queue_1`, `${envPath}/concurrency`, true)).toBe(true);

      // /billing must not match /billing-limits
      expect(matchesPath(`${orgPath}/settings/billing-limits`, `${orgPath}/settings/billing`, true)).toBe(false);
      expect(matchesPath(`${orgPath}/settings/billing/invoices`, `${orgPath}/settings/billing`, true)).toBe(true);
    });
  });

  describe("1. Main section routes", () => {
    it("highlights the exact section route when visited", () => {
      // Tasks main route
      expect(
        isSideMenuItemActive({
          currentPath: envPath,
          targetPath: envPath,
          nestedPaths: [`${envPath}/tasks`, `${envPath}/agents`],
        })
      ).toBe(true);

      // Runs main route
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/runs`,
          targetPath: `${envPath}/runs`,
          matchPrefix: true,
        })
      ).toBe(true);

      // Sessions main route
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/sessions`,
          targetPath: `${envPath}/sessions`,
          matchPrefix: true,
        })
      ).toBe(true);

      // Concurrency main route
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/concurrency`,
          targetPath: `${envPath}/concurrency`,
          matchPrefix: true,
        })
      ).toBe(true);

      // Deployments main route
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/deployments`,
          targetPath: `${envPath}/deployments`,
          matchPrefix: true,
        })
      ).toBe(true);
    });
  });

  describe("2. Nested detail routes", () => {
    it("keeps parent navigation items highlighted on detail routes", () => {
      // Sessions detail
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/sessions/session_123`,
          targetPath: `${envPath}/sessions`,
          matchPrefix: true,
        })
      ).toBe(true);

      // Webhooks endpoint detail
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/webhooks/endpoints/ep_abc`,
          targetPath: `${envPath}/webhooks`,
          matchPrefix: true,
        })
      ).toBe(true);

      // Webhooks delivery detail
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/webhooks/deliveries/del_xyz`,
          targetPath: `${envPath}/webhooks`,
          matchPrefix: true,
        })
      ).toBe(true);

      // Prompts detail
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/prompts/my-prompt`,
          targetPath: `${envPath}/prompts`,
          matchPrefix: true,
        })
      ).toBe(true);

      // Models detail
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/models/gpt-4o`,
          targetPath: `${envPath}/models`,
          matchPrefix: true,
        })
      ).toBe(true);

      // Models compare
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/models/compare`,
          targetPath: `${envPath}/models`,
          matchPrefix: true,
        })
      ).toBe(true);

      // Alerts detail
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/alerts/alert_123`,
          targetPath: `${envPath}/alerts`,
          matchPrefix: true,
        })
      ).toBe(true);

      // Alerts new
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/alerts/new`,
          targetPath: `${envPath}/alerts`,
          matchPrefix: true,
        })
      ).toBe(true);

      // Errors detail
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/errors/err_fingerprint_abc`,
          targetPath: `${envPath}/errors`,
          matchPrefix: true,
        })
      ).toBe(true);

      // Deployments detail
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/deployments/dep_456`,
          targetPath: `${envPath}/deployments`,
          matchPrefix: true,
        })
      ).toBe(true);

      // Environment variables new
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/environment-variables/new`,
          targetPath: `${envPath}/environment-variables`,
          matchPrefix: true,
        })
      ).toBe(true);

      // Waitpoint tokens detail
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/waitpoints/tokens/wpt_789`,
          targetPath: `${envPath}/waitpoints/tokens`,
          matchPrefix: true,
        })
      ).toBe(true);

      // Batches detail
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/batches/batch_123`,
          targetPath: `${envPath}/batches`,
          matchPrefix: true,
        })
      ).toBe(true);

      // Bulk actions detail
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/bulk-actions/action_999`,
          targetPath: `${envPath}/bulk-actions`,
          matchPrefix: true,
        })
      ).toBe(true);
    });
  });

  describe("3. Tasks detail pages", () => {
    const tasksItemConfig = {
      targetPath: envPath,
      nestedPaths: [`${envPath}/tasks`, `${envPath}/agents`],
      yieldActiveToFavorite: true,
    };

    it("highlights Tasks on standard task detail page", () => {
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/tasks/standard/process-order`,
          ...tasksItemConfig,
        })
      ).toBe(true);
    });

    it("highlights Tasks on scheduled task detail page", () => {
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/tasks/scheduled/nightly-cleanup`,
          ...tasksItemConfig,
        })
      ).toBe(true);
    });

    it("highlights Tasks on tasks dashboard and stream pages", () => {
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/tasks/dashboard`,
          ...tasksItemConfig,
        })
      ).toBe(true);

      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/tasks/stream`,
          ...tasksItemConfig,
        })
      ).toBe(true);
    });

    it("highlights Tasks on agent task detail page", () => {
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/agents/support-bot`,
          ...tasksItemConfig,
        })
      ).toBe(true);
    });

    it("does NOT highlight Tasks on other environment sections", () => {
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/runs`,
          ...tasksItemConfig,
        })
      ).toBe(false);

      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/sessions`,
          ...tasksItemConfig,
        })
      ).toBe(false);

      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/alerts`,
          ...tasksItemConfig,
        })
      ).toBe(false);

      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/deployments`,
          ...tasksItemConfig,
        })
      ).toBe(false);
    });

    it("supports relative nestedPaths for Tasks", () => {
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/tasks/standard/my-task`,
          targetPath: envPath,
          nestedPaths: ["/tasks", "/agents"],
        })
      ).toBe(true);

      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/agents/agent-task`,
          targetPath: envPath,
          nestedPaths: ["/tasks", "/agents"],
        })
      ).toBe(true);

      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/runs`,
          targetPath: envPath,
          nestedPaths: ["/tasks", "/agents"],
        })
      ).toBe(false);
    });
  });

  describe("4. Runs detail pages", () => {
    const runsItemConfig = {
      targetPath: `${envPath}/runs`,
      matchPrefix: true,
      yieldActiveToFavorite: true,
    };

    it("highlights Runs on individual run detail page", () => {
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/runs/run_cm123456789`,
          ...runsItemConfig,
        })
      ).toBe(true);
    });

    it("highlights Runs on nested run streaming and span subpages", () => {
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/runs/run_cm123456789/stream`,
          ...runsItemConfig,
        })
      ).toBe(true);

      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/runs/run_cm123456789/spans/span_001`,
          ...runsItemConfig,
        })
      ).toBe(true);
    });

    it("does NOT highlight Runs on unrelated sibling sections", () => {
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/sessions`,
          ...runsItemConfig,
        })
      ).toBe(false);

      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/tasks/standard/test`,
          ...runsItemConfig,
        })
      ).toBe(false);
    });
  });

  describe("5. Similar but unrelated route prefixes (Path Boundary Respect)", () => {
    it("/concurrency does not activate on /concurrency-limits", () => {
      const concurrencyItem = {
        targetPath: `${envPath}/concurrency`,
        matchPrefix: true,
      };

      const concurrencyLimitsItem = {
        targetPath: `${envPath}/concurrency-limits`,
        matchPrefix: true,
      };

      // On /concurrency-limits:
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/concurrency-limits`,
          ...concurrencyItem,
        })
      ).toBe(false);

      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/concurrency-limits`,
          ...concurrencyLimitsItem,
        })
      ).toBe(true);

      // On /concurrency/queue_alpha:
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/concurrency/queue_alpha`,
          ...concurrencyItem,
        })
      ).toBe(true);

      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/concurrency/queue_alpha`,
          ...concurrencyLimitsItem,
        })
      ).toBe(false);
    });

    it("/runs does not activate on /runs-archived", () => {
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/runs-archived`,
          targetPath: `${envPath}/runs`,
          matchPrefix: true,
        })
      ).toBe(false);
    });

    it("/billing does not activate on /billing-limits", () => {
      expect(
        isSideMenuItemActive({
          currentPath: `${orgPath}/settings/billing-limits`,
          targetPath: `${orgPath}/settings/billing`,
          matchPrefix: true,
        })
      ).toBe(false);
    });
  });

  describe("6. Dashboard-specific routes", () => {
    const dashboardsLandingItem = {
      targetPath: `${envPath}/dashboards`,
      matchPrefix: false, // Dashboards landing page only
      yieldActiveToFavorite: true,
    };

    const runMetricsItem = {
      targetPath: `${envPath}/dashboards/overview`,
      matchPrefix: true,
      yieldActiveToFavorite: true,
    };

    const aiMetricsItem = {
      targetPath: `${envPath}/dashboards/llm`,
      matchPrefix: true,
      yieldActiveToFavorite: true,
    };

    const customDashboardItem = {
      targetPath: `${envPath}/dashboards/custom/db_sales`,
      matchPrefix: true,
      yieldActiveToFavorite: true,
    };

    it("highlights parent Dashboards item only on the landing page", () => {
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/dashboards`,
          ...dashboardsLandingItem,
        })
      ).toBe(true);

      // On landing page, specific dashboards are not active
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/dashboards`,
          ...runMetricsItem,
        })
      ).toBe(false);
    });

    it("retains active state on specific dashboard items without activating the landing parent", () => {
      // Visiting Run metrics:
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/dashboards/overview`,
          ...runMetricsItem,
        })
      ).toBe(true);

      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/dashboards/overview`,
          ...dashboardsLandingItem,
        })
      ).toBe(false);

      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/dashboards/overview`,
          ...aiMetricsItem,
        })
      ).toBe(false);

      // Visiting AI metrics:
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/dashboards/llm`,
          ...aiMetricsItem,
        })
      ).toBe(true);

      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/dashboards/llm`,
          ...dashboardsLandingItem,
        })
      ).toBe(false);

      // Visiting Custom dashboard:
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/dashboards/custom/db_sales`,
          ...customDashboardItem,
        })
      ).toBe(true);

      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/dashboards/custom/db_sales`,
          ...dashboardsLandingItem,
        })
      ).toBe(false);
    });

    it("allows custom dashboard item to retain active state on nested widgets/subroutes", () => {
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/dashboards/custom/db_sales/widgets/w_revenue`,
          ...customDashboardItem,
        })
      ).toBe(true);

      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/dashboards/custom/db_sales/widgets/w_revenue`,
          ...dashboardsLandingItem,
        })
      ).toBe(false);
    });
  });

  describe("7. Favourite navigation behaviour", () => {
    it("yields active state to active favorite when yieldActiveToFavorite is true", () => {
      const runsItem = {
        targetPath: `${envPath}/runs`,
        matchPrefix: true,
        yieldActiveToFavorite: true,
      };

      // Current view matches an active favorite
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/runs/run_123`,
          ...runsItem,
          activeFavoriteId: "fav_run_123",
        })
      ).toBe(false);

      // The favorite item itself uses isActiveOverride: true
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/runs/run_123`,
          targetPath: `${envPath}/runs/run_123?fav=fav_run_123`,
          isActiveOverride: true,
        })
      ).toBe(true);
    });

    it("keeps regular highlight when no favorite owns the view", () => {
      const runsItem = {
        targetPath: `${envPath}/runs`,
        matchPrefix: true,
        yieldActiveToFavorite: true,
      };

      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/runs/run_123`,
          ...runsItem,
          activeFavoriteId: undefined,
        })
      ).toBe(true);
    });

    it("yields active state on Tasks detail pages when a favorite is active", () => {
      const tasksItem = {
        targetPath: envPath,
        nestedPaths: [`${envPath}/tasks`, `${envPath}/agents`],
        yieldActiveToFavorite: true,
      };

      // Active favorite on task detail page
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/tasks/standard/my-task`,
          ...tasksItem,
          activeFavoriteId: "fav_task_my_task",
        })
      ).toBe(false);

      // Normal navigation without favorite marker
      expect(
        isSideMenuItemActive({
          currentPath: `${envPath}/tasks/standard/my-task`,
          ...tasksItem,
          activeFavoriteId: undefined,
        })
      ).toBe(true);
    });

    it("does not yield when yieldActiveToFavorite is false", () => {
      expect(
        isSideMenuItemActive({
          currentPath: "/account",
          targetPath: "/account",
          yieldActiveToFavorite: false,
          activeFavoriteId: "fav_something",
        })
      ).toBe(true);
    });
  });
});

