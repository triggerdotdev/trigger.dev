import { describe, expect, test } from "vitest";
import {
  isVercelSecretType,
  mergeVercelEnvironmentVariableValues,
  resolveVercelSharedValue,
  toVercelEnvironmentVariableValue,
} from "~/v3/vercel/environmentVariableValues";

describe("Vercel environment values", () => {
  test.each(["", "  ", "text"])(
    "retains project value %j and its key for shared precedence",
    (value) => {
      expect(
        toVercelEnvironmentVariableValue({
          key: "OVERRIDE",
          value,
          type: "plain",
          target: ["production"],
        })
      ).toEqual({ key: "OVERRIDE", value, type: "plain", target: ["production"], isSecret: false });
    }
  );

  test("omits an unavailable project value", () => {
    expect(toVercelEnvironmentVariableValue({ key: "MISSING", type: "plain" })).toBeNull();
  });

  test("an inline shared empty value avoids fetching and cannot be replaced by a fallback", async () => {
    const value = await resolveVercelSharedValue("", async () => {
      throw new Error("An inline value must not fetch a fallback");
    });
    expect(value).toBe("");
  });

  test.each([null, undefined])(
    "an absent shared value (%s) can resolve to empty",
    async (inline) => {
      expect(await resolveVercelSharedValue(inline, async () => "")).toBe("");
      expect(await resolveVercelSharedValue(inline, async () => null)).toBeNull();
    }
  );

  test("Vercel secret and sensitive types remain excluded", () => {
    expect(isVercelSecretType("secret")).toBe(true);
    expect(isVercelSecretType("sensitive")).toBe(true);
    expect(isVercelSecretType("encrypted")).toBe(false);
    expect(isVercelSecretType("plain")).toBe(false);
  });
});

test("an empty project value overrides a nonempty shared value", () => {
  const project = toVercelEnvironmentVariableValue({ key: "OVERRIDE", value: "", type: "plain" });
  expect(project).not.toBeNull();
  const merged = mergeVercelEnvironmentVariableValues(project ? [project] : [], [
    { key: "OVERRIDE", value: "shared" },
    { key: "SHARED_ONLY", value: "" },
  ]);
  expect(merged.map(({ key, value }) => ({ key, value }))).toEqual([
    { key: "OVERRIDE", value: "" },
    { key: "SHARED_ONLY", value: "" },
  ]);
});

test.each(["", " \t "])("disabled rollout filters %j before merging", async (value) => {
  const project = toVercelEnvironmentVariableValue(
    { key: "OVERRIDE", value, type: "plain" },
    false
  );
  expect(project).toBeNull();
  expect(
    mergeVercelEnvironmentVariableValues(project ? [project] : [], [
      { key: "OVERRIDE", value: "shared" },
    ])
  ).toEqual([{ key: "OVERRIDE", value: "shared" }]);
  expect(await resolveVercelSharedValue(value, async () => "fallback", false)).toBe("fallback");
  expect(await resolveVercelSharedValue(undefined, async () => value, false)).toBeNull();
});
