import { calculateResetAt } from "../src/taskUtils";

describe("calculateResetAt", () => {
  it("Should be able to correctly calculate based on a variety of formats", () => {
    const now = new Date("2023-01-01T00:00:00.000Z");

    expect(calculateResetAt("1s", now)).toEqual(new Date("2023-01-01T00:00:01.000Z"));
    expect(calculateResetAt("6m59s", now)).toEqual(new Date("2023-01-01T00:06:59.000Z"));
    expect(calculateResetAt("5m48s", now)).toEqual(new Date("2023-01-01T00:05:48.000Z"));
    expect(calculateResetAt("1h44m5s", now)).toEqual(new Date("2023-01-01T01:44:05.000Z"));
    expect(calculateResetAt("1h2s", now)).toEqual(new Date("2023-01-01T01:00:02.000Z"));
    expect(calculateResetAt("45m", now)).toEqual(new Date("2023-01-01T00:45:00.000Z"));
    expect(calculateResetAt("23h59m0s", now)).toEqual(new Date("2023-01-01T23:59:00.000Z"));
    expect(calculateResetAt("1d22h8m1s", now)).toEqual(new Date("2023-01-02T22:08:01.000Z"));
    expect(calculateResetAt("3h36m7.312s", now)).toEqual(new Date("2023-01-01T03:36:07.312Z"));
    expect(calculateResetAt("72ms", now)).toEqual(new Date("2023-01-01T00:00:00.072Z"));
  });
});
