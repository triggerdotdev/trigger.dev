import { asSchema, type Tool } from "ai";
import { describe, expect, it } from "vitest";
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

describe("what the model is told about watches", () => {
  for (const mode of ["assistant", "code"] as const) {
    for (const watchEnabled of [false, true]) {
      it(`${watchEnabled ? "mentions" : "never mentions"} watches in ${mode} mode`, () => {
        const ctx = {
          projectRef: "proj_abc",
          environmentId: "env_abc",
          watchEnabled,
          ...(mode === "code" ? { repoSnapshot: snapshot } : {}),
        };
        const surfaces = {
          system: systemPromptFor(mode, { watchEnabled }),
          schemas: serialize(toolSchemasFor(mode, { watchEnabled })),
          tools: serialize(buildDashboardAgentTools(ctx)),
          renderView: serialize({ render_view: buildDashboardAgentTools(ctx).render_view }),
        };
        for (const text of Object.values(surfaces)) {
          expect(/watch/i.test(text)).toBe(watchEnabled);
        }
      });
    }
  }
});
