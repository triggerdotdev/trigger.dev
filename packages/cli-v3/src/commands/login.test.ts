import { describe, expect, it } from "vitest";
import { CLOUD_API_URL } from "../consts.js";
import { resolveLoginOptions } from "./login.js";

describe("resolveLoginOptions", () => {
  it("uses the cloud API when the caller passes an undefined override", () => {
    expect(resolveLoginOptions({ defaultApiUrl: undefined }).defaultApiUrl).toBe(CLOUD_API_URL);
  });

  it("preserves an explicit API URL", () => {
    expect(
      resolveLoginOptions({ defaultApiUrl: "https://trigger.example.com" }).defaultApiUrl
    ).toBe("https://trigger.example.com");
  });
});
