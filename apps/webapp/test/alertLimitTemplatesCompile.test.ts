import { V1_CAPABILITIES, compileTemplate } from "@internal/alert-contracts";
import { compileTSQL } from "@internal/tsql";
import { describe, expect, it } from "vitest";
import { querySchemas } from "~/v3/querySchemas";

const LIMITS = V1_CAPABILITIES.filter((c) => c.key.startsWith("limits.") && c.key !== "limits.all");

function compile(template: string, params: Record<string, number>) {
  return compileTSQL(compileTemplate(template, "1 = 1", params), {
    tableSchema: querySchemas,
    enforcedWhereClause: {
      organization_id: { op: "eq", value: "org_1" },
      project_id: { op: "eq", value: "proj_1" },
      environment_id: { op: "eq", value: "env_1" },
    },
  });
}

describe("limits capability templates", () => {
  it("covers every limits capability", () => {
    expect(LIMITS.length).toBe(7);
  });

  it.each(LIMITS.map((c) => [c.key, c] as const))("%s compiles", (_key, cap) => {
    const params = Object.fromEntries((cap.binding.params ?? []).map((p) => [p.key, p.default]));
    const templates = [cap.binding.template!, ...Object.values(cap.binding.signalTemplates ?? {})];
    for (const template of templates) {
      const { sql } = compile(template, params);
      expect(sql).toContain(
        cap.binding.table === "env_metrics"
          ? "trigger_dev.env_metrics_v1"
          : "trigger_dev.metrics_v1"
      );
    }
  });

  it("rejects a template referencing a column the table does not have", () => {
    const cap = LIMITS.find((c) => c.key === "limits.webhooks.endpoint_rate")!;
    expect(() =>
      compile(cap.binding.template!.replace("machine_id", "metric_subject"), {
        utilisationPct: 80,
      })
    ).toThrow();
  });
});
