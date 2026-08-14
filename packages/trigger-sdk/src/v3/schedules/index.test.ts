import { resourceCatalog } from "@trigger.dev/core/v3";
import { StandardResourceCatalog } from "@trigger.dev/core/v3/workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { task } from "./index.js";

describe("declarative schedule windows", () => {
  beforeEach(() => {
    resourceCatalog.disable();
    resourceCatalog.setGlobalResourceCatalog(new StandardResourceCatalog());
    resourceCatalog.setCurrentFileContext("scheduled.ts", "scheduled.ts");
  });

  afterEach(() => {
    resourceCatalog.clearCurrentFileContext();
    resourceCatalog.disable();
  });

  it.each(["0m", "30m", "2h", "24h", "30%"] as const)(
    "serializes the %s window into task metadata",
    (window) => {
      task({
        id: "daily-report",
        cron: {
          pattern: "0 9 * * *",
          timezone: "Europe/London",
          window,
          environments: ["PRODUCTION"],
        },
        run: async () => undefined,
      });

      expect(resourceCatalog.getTaskManifest("daily-report")?.schedule).toEqual({
        cron: "0 9 * * *",
        timezone: "Europe/London",
        window,
        environments: ["PRODUCTION"],
      });
    }
  );

  it("leaves the window undefined when it is omitted", () => {
    task({
      id: "hourly-report",
      cron: { pattern: "0 * * * *" },
      run: async () => undefined,
    });

    expect(resourceCatalog.getTaskManifest("hourly-report")?.schedule).toEqual({
      cron: "0 * * * *",
      timezone: "UTC",
      window: undefined,
      environments: undefined,
    });
  });
});
