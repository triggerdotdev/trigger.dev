import { asSchema, type Tool } from "ai";
import { describe, expect, it } from "vitest";
import { scopeTurnTools } from "./agent-runtime";
import { systemPromptFor, toolSchemasFor } from "./prompt-assembly";
import type { RepoSnapshot } from "./repo-tools";
import { buildDashboardAgentTools } from "./tools";

const snapshot: RepoSnapshot = {
  tarballUrl: "http://unused.invalid/never-fetched",
  owner: "acme",
  repo: "demo",
  sha: "deadbeefdeadbeef",
};

function serialize(tools: Record<string, Tool<any, any>>): string {
  return JSON.stringify(
    Object.entries(tools).map(([name, definition]) => ({
      name,
      description: definition.description ?? "",
      inputSchema: asSchema(definition.inputSchema as never).jsonSchema,
    }))
  );
}

// The Watch planner says "watch" too, so only the legacy watch surfaces are gated here.
const LEGACY_WATCH = /schedule_watch|watch_subscription|`watch`|watch configuration card/i;

describe("what the model is told about watches", () => {
  for (const mode of ["assistant", "code"] as const) {
    for (const watchEnabled of [false, true]) {
      it(`${watchEnabled ? "mentions" : "never mentions"} watches in ${mode} mode`, () => {
        const ctx = {
          projectRef: "proj_abc",
          environmentId: "env_abc",
          legacyWatchEnabled: watchEnabled,
          ...(mode === "code" ? { repoSnapshot: snapshot } : {}),
        };
        const surfaces = {
          system: systemPromptFor(mode, { legacyWatchEnabled: watchEnabled }),
          schemas: serialize(toolSchemasFor(mode, { legacyWatchEnabled: watchEnabled })),
          tools: serialize(buildDashboardAgentTools(ctx)),
          renderView: serialize({ render_view: buildDashboardAgentTools(ctx).render_view }),
        };
        for (const text of Object.values(surfaces)) {
          expect(LEGACY_WATCH.test(text)).toBe(watchEnabled);
        }
      });
    }
  }

  for (const mode of ["assistant", "code"] as const) {
    it(`never mentions watches in an alert-creation turn in ${mode} mode`, () => {
      const ctx = {
        projectRef: "proj_abc",
        environmentId: "env_abc",
        watchEnabled: false,
        toolScope: "alert_creation",
        ...(mode === "code" ? { repoSnapshot: snapshot } : {}),
      };
      const options = { watchEnabled: false, scope: "alert_creation" } as const;
      const schemas = toolSchemasFor(mode, options);
      const tools = scopeTurnTools(buildDashboardAgentTools(ctx), ctx);
      expect(schemas).toHaveProperty("update_alert_draft");
      expect(tools).toHaveProperty("update_alert_draft");
      const surfaces = [systemPromptFor(mode, options), serialize(schemas), serialize(tools)];
      for (const text of surfaces) {
        expect(text).not.toMatch(LEGACY_WATCH);
      }
    });
  }
});

// Catches: the planner section left in the base prompt, offering a plan with no tool behind it.
describe("what the model is told about planning alerts", () => {
  const PLANNER = /plan_monitoring|plan_decision|Set up a watch/;
  for (const mode of ["assistant", "code"] as const) {
    it.each([
      [{}, false],
      [{ alertsEnabled: true }, true],
      [{ watchEnabled: true }, true],
      [{ alertsEnabled: true, scope: "alert_creation" as const }, false],
    ])(`in ${mode} mode with %o, mentions the planner: %s`, (options, expected) => {
      expect(PLANNER.test(systemPromptFor(mode, options))).toBe(expected);
    });
  }
});
