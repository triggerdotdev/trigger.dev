import { describe, expect, it } from "vitest";
import { sanitizeHttpUrl } from "../app/utils/sanitizeHttpUrl.js";

describe("sanitizeHttpUrl", () => {
  it.each([
    ["/magic?token=secret", "/magic"],
    [
      "/orgs/acme/projects/demo/runs?search=needle&query=status%3Afailed&_data=routes&tableState=open",
      "/orgs/acme/projects/demo/runs",
    ],
    ["/account/authorization-code/code_secret", "/account/authorization-code/[redacted]"],
    [
      "/account/authorization-code/code_secret?utm_source=cli",
      "/account/authorization-code/[redacted]",
    ],
    ["/healthcheck", "/healthcheck"],
  ])("sanitizes %s", (value, expected) => {
    expect(sanitizeHttpUrl(value)).toBe(expected);
  });
});
