import { describe, expect, it } from "vitest";
import { deploymentStatusFilterSql } from "~/presenters/v3/deploymentStatusFilter";
import type { DeploymentDisplayStatus } from "~/components/runs/v3/DeploymentStatus";

describe("deploymentStatusFilterSql", () => {
  // Catches: statuses bound as one array parameter, which keeps the planner off
  // (environmentId, status, id) and reads every deployment in the environment.
  it("writes stored statuses as literals, not bound parameters", () => {
    const sql = deploymentStatusFilterSql(["FAILED", "TIMED_OUT"]);
    expect(sql.sql).toBe(`AND (wd."status" IN ('FAILED', 'TIMED_OUT'))`);
    expect(sql.values).toEqual([]);
  });

  it("splits canceled into canceled and superseded", () => {
    expect(deploymentStatusFilterSql(["CANCELED"]).sql).toBe(
      `AND ((wd."status" = 'CANCELED' AND wd."supersededById" IS NULL))`
    );
    expect(deploymentStatusFilterSql(["DEPLOYED", "SUPERSEDED"]).sql).toBe(
      `AND (wd."status" IN ('DEPLOYED') OR (wd."status" = 'CANCELED' AND wd."supersededById" IS NOT NULL))`
    );
  });

  // Catches: a value outside the enum reaching the SQL text.
  it("drops values that aren't statuses", () => {
    const statuses = ["FAILED", "x') OR TRUE --"] as unknown as DeploymentDisplayStatus[];
    expect(deploymentStatusFilterSql(statuses).sql).toBe(`AND (wd."status" IN ('FAILED'))`);
    expect(
      deploymentStatusFilterSql(["toString"] as unknown as DeploymentDisplayStatus[]).sql
    ).toBe("AND FALSE");
  });
});
