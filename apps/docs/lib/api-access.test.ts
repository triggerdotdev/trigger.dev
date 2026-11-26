import { describe, expect, it } from "vitest";
import { accessLabel, covers, sampleAccess } from "./api-access";

// The default docs key on cloud (the Operator preset), abridged.
const OPERATOR = ["trigger:tasks", "batchTrigger:batch", "read:runs", "write:runs", "read:queues"];

describe("covers", () => {
  it("picks a key whose scopes grant every needed scope", () => {
    expect(covers(OPERATOR, ["read:runs"])).toBe(true);
    expect(covers(OPERATOR, ["read:runs", "trigger:tasks"])).toBe(true);
  });

  // Catches: the playground sending an env vars request with a key that will get a 403.
  it("doesn't pick a key missing one of them", () => {
    expect(covers(OPERATOR, ["read:envvars"])).toBe(false);
    expect(covers(["read:envvars"], ["write:envvars"])).toBe(false);
  });

  it("treats admin, action:all and unrestricted keys as covering", () => {
    expect(covers(["admin"], ["write:schedules"])).toBe(true);
    expect(covers(["read:all"], ["read:query"])).toBe(true);
    expect(covers(null, ["write:deployments"])).toBe(true);
  });
});

describe("sampleAccess", () => {
  it("asks for the areas the default key doesn't cover", () => {
    expect(sampleAccess(`await envvars.upload("proj_1234", "dev", { variables })`)).toEqual([
      "write:envvars",
    ]);
    expect(
      sampleAccess(`const s = await schedules.create({ task: "t", cron: "0 * * * *" });
const all = await schedules.list();`)
    ).toEqual(["read:schedules", "write:schedules"]);
    expect(sampleAccess(`const rows = await query.execute("SELECT 1")`)).toEqual(["read:query"]);
  });

  it("leaves samples the default key covers alone", () => {
    expect(sampleAccess(`await tasks.trigger("hello", {})`)).toBeNull();
    expect(
      sampleAccess(`export const t = schedules.task({ id: "x", run: async () => {} })`)
    ).toBeNull();
  });

  it("labels access", () => {
    expect(accessLabel("read:envvars")).toBe("Env vars: read");
  });
});
