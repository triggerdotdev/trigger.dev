import { compileTemplate, getCapability } from "@internal/alert-contracts";
import { compileTSQL } from "@internal/tsql";
import { describe, expect, it } from "vitest";
import { keysetAfter } from "~/v3/services/alerts/evaluators/queryEvaluator.server";
import { querySchemas } from "~/v3/querySchemas";

const CTX = { checkpoint: "'2026-01-01 00:00:00.000'", after: "1 = 1" };

const SCOPES: Record<string, string[]> = {
  "errors.new": ["1 = 1", "task_identifier = 'task-a'"],
  "errors.occurred_again": ["task_identifier = 'task-a' AND error_fingerprint = 'fp-a'"],
};

function compile(template: string, scope: string, ctx: Record<string, string> = CTX) {
  return compileTSQL(compileTemplate(template, scope, undefined, ctx), {
    tableSchema: querySchemas,
    enforcedWhereClause: {
      organization_id: { op: "eq", value: "org_1" },
      project_id: { op: "eq", value: "proj_1" },
      environment_id: { op: "eq", value: "env_1" },
    },
  });
}

describe("errors capability templates", () => {
  for (const [key, scopes] of Object.entries(SCOPES)) {
    const capability = getCapability(key);

    for (const scope of scopes) {
      it(`${key} main and series templates compile for scope ${scope}`, () => {
        expect(capability, key).toBeDefined();
        const { template, seriesTemplate, table } = capability!.binding;
        expect(template && seriesTemplate, key).toBeTruthy();
        for (const tsql of [template!, seriesTemplate!]) {
          const { sql } = compile(tsql, scope);
          expect(sql).toContain(
            table === "errors" ? "trigger_dev.errors_v1" : "trigger_dev.error_occurrences_v1"
          );
          expect(sql).toContain(".environment_id, {tsql_val_");
        }
      });
    }
  }

  it.each([
    ["errors.new", "group_first_seen"],
    ["errors.occurred_again", "minute"],
  ])("%s main template compiles with a keyset cursor", (key, timeColumn) => {
    const after = keysetAfter([
      [timeColumn, "2026-01-01 00:05:00.000"],
      ["task_identifier", "task-a"],
      ["error_fingerprint", "fp'b"],
    ]);
    const { sql } = compile(getCapability(key)!.binding.template!, SCOPES[key]![0]!, {
      ...CTX,
      after,
    });
    expect(sql).toContain("error_fingerprint");
    expect(sql).toMatch(/ORDER BY .*error_fingerprint ASC/);
  });

  it("rejects a template referencing a column the table does not have", () => {
    const template = getCapability("errors.occurred_again")!.binding.template!;
    expect(() =>
      compile(template.replace("sum(count)", "sum(occurrences_total)"), "1 = 1")
    ).toThrow();
  });
});
