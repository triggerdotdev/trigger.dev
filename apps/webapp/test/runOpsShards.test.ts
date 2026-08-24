import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseRunOpsShards, validateShardListAgainstNewUrl } from "~/v3/runOpsShards.server";

function run(raw: string | undefined) {
  const schema = z.string().optional().transform(parseRunOpsShards);
  return schema.safeParse(raw);
}

const valid = {
  key: "a",
  region: "us-east-1",
  url: "postgres://h/db",
  replication: { slotName: "s", publicationName: "p", originGeneration: 2 },
};

describe("parseRunOpsShards", () => {
  it("returns [] for undefined", () => {
    const r = run(undefined);
    expect(r.success && r.data).toEqual([]);
  });
  it("returns [] for an empty array literal", () => {
    const r = run("[]");
    expect(r.success && r.data).toEqual([]);
  });
  it("parses a valid single descriptor", () => {
    const r = run(JSON.stringify([valid]));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data[0].key).toBe("a");
  });
  it("fails on malformed JSON", () => {
    expect(run("{not json").success).toBe(false);
  });
  it("fails on a multi-char key", () => {
    expect(run(JSON.stringify([{ ...valid, key: "ab" }])).success).toBe(false);
  });
  it("fails on duplicate keys", () => {
    const b = {
      ...valid,
      replication: { slotName: "s2", publicationName: "p2", originGeneration: 3 },
    };
    expect(run(JSON.stringify([valid, b])).success).toBe(false);
  });
  it("fails on duplicate origin generations", () => {
    const b = { ...valid, key: "b", url: "postgres://h/b" };
    expect(run(JSON.stringify([valid, b])).success).toBe(false);
  });
  it("fails when both url and aliasOf are set", () => {
    expect(
      run(JSON.stringify([{ key: "a", region: "x", url: "postgres://h/db", aliasOf: "new" }]))
        .success
    ).toBe(false);
  });
  it("accepts aliasOf without url or replication", () => {
    expect(run(JSON.stringify([{ key: "a", region: "x", aliasOf: "new" }])).success).toBe(true);
  });
  it("fails on an origin generation below 2 or above 255", () => {
    const mk = (g: number) =>
      run(
        JSON.stringify([
          { ...valid, replication: { slotName: "s", publicationName: "p", originGeneration: g } },
        ])
      );
    expect(mk(1).success).toBe(false);
    expect(mk(256).success).toBe(false);
  });
  it("fails when a non-aliased descriptor omits replication", () => {
    expect(run(JSON.stringify([{ key: "a", region: "x", url: "postgres://h/db" }])).success).toBe(
      false
    );
  });
});

describe("validateShardListAgainstNewUrl", () => {
  it("passes when the list is empty and no new url", () => {
    expect(validateShardListAgainstNewUrl([], undefined)).toBe(true);
  });
  it("passes when the list is non-empty and new url is set", () => {
    expect(validateShardListAgainstNewUrl([valid as never], "postgres://h/new")).toBe(true);
  });
  it("fails when the list is non-empty and new url is unset", () => {
    expect(validateShardListAgainstNewUrl([valid as never], undefined)).toBe(false);
  });
});
