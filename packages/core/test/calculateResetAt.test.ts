import { calculateResetAt } from "../src/retry.js";

describe("calculateResetAt", () => {
  it("Should be able to correctly calculate iso_8601_duration_openai_variant reset values", () => {
    const now = new Date("2023-01-01T00:00:00.000Z");

    expect(calculateResetAt("1s", "iso_8601_duration_openai_variant", now)).toEqual(
      new Date("2023-01-01T00:00:01.000Z")
    );
    expect(calculateResetAt("6m59s", "iso_8601_duration_openai_variant", now)).toEqual(
      new Date("2023-01-01T00:06:59.000Z")
    );
    expect(calculateResetAt("5m48s", "iso_8601_duration_openai_variant", now)).toEqual(
      new Date("2023-01-01T00:05:48.000Z")
    );
    expect(calculateResetAt("1h44m5s", "iso_8601_duration_openai_variant", now)).toEqual(
      new Date("2023-01-01T01:44:05.000Z")
    );
    expect(calculateResetAt("1h2s", "iso_8601_duration_openai_variant", now)).toEqual(
      new Date("2023-01-01T01:00:02.000Z")
    );
    expect(calculateResetAt("45m", "iso_8601_duration_openai_variant", now)).toEqual(
      new Date("2023-01-01T00:45:00.000Z")
    );
    expect(calculateResetAt("23h59m0s", "iso_8601_duration_openai_variant", now)).toEqual(
      new Date("2023-01-01T23:59:00.000Z")
    );
    expect(calculateResetAt("1d22h8m1s", "iso_8601_duration_openai_variant", now)).toEqual(
      new Date("2023-01-02T22:08:01.000Z")
    );
    expect(calculateResetAt("3h36m7.312s", "iso_8601_duration_openai_variant", now)).toEqual(
      new Date("2023-01-01T03:36:07.312Z")
    );
    expect(calculateResetAt("72ms", "iso_8601_duration_openai_variant", now)).toEqual(
      new Date("2023-01-01T00:00:00.072Z")
    );
  });

  it("Should be able to correctly calculate unix_timestamp reset values", () => {
    expect(calculateResetAt("1699369436", "unix_timestamp")).toEqual(
      new Date("2023-11-07T15:03:56.000Z")
    );
  });

  it("Should be able to correctly calculate unix_timestamp_in_ms reset values", () => {
    expect(calculateResetAt("1699369436000", "unix_timestamp_in_ms")).toEqual(
      new Date("2023-11-07T15:03:56.000Z")
    );
  });

  it("Should be able to correctly calculate iso_8601 reset values", () => {
    expect(calculateResetAt("2023-11-07T15:03:56.000Z", "iso_8601")).toEqual(
      new Date("2023-11-07T15:03:56.000Z")
    );
  });
});
