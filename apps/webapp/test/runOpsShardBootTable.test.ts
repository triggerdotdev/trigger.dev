import { describe, expect, it } from "vitest";
import { runOpsAddressFingerprint, buildRunOpsShardTable } from "~/db.server";

describe("runOpsAddressFingerprint", () => {
  it("returns host:port/db with no username or query params", () => {
    const fp = runOpsAddressFingerprint(
      "postgres://user:pw@host.example:5433/mydb?schema=public&pool_timeout=20"
    );
    expect(fp).toBe("host.example:5433/mydb");
    expect(fp).not.toContain("user");
    expect(fp).not.toContain("pool_timeout");
  });
  it("defaults the port to 5432", () => {
    expect(runOpsAddressFingerprint("postgres://h/db")).toBe("h:5432/db");
  });
  it("returns a marker on unparseable input rather than throwing", () => {
    expect(runOpsAddressFingerprint("not a url")).toBe("unparseable");
  });
});

describe("buildRunOpsShardTable", () => {
  it("one row per descriptor, with key, fingerprint, and role", () => {
    const rows = buildRunOpsShardTable([
      { key: "a", url: "postgres://user:pw@h/adb?schema=public" },
      { key: "b", aliasOf: "new" },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ key: "a", fingerprint: "h:5432/adb", role: "shard" });
    expect(rows[1]).toEqual({ key: "b", fingerprint: "alias(new)", role: "alias(new)" });
  });
  it("is empty for an empty descriptor list", () => {
    expect(buildRunOpsShardTable([])).toEqual([]);
  });
});
